import { pool, parseMySQLDate, withTransaction } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import {
  AppError,
  NotFoundError,
  ConflictError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  parseMuscleGroups,
  EXERCISE_MUSCLE_COLS,
  SET_FROM,
  type HistoryCursor,
} from "@/features/workouts/workouts.model.js"
import { parseUuidParam } from "@/middleware/validation.js"
import type {
  Permission,
  PermissionType,
  JointSession,
  ParticipantProgress,
  JointSessionParticipant,
} from "../social.types.js"

interface PermissionRow extends RowDataPacket {
  id: number
  fromUserId?: string
  toUserId?: string
  permissionType: PermissionType
  /** JSON column. See parsePayload. */
  payload: Record<string, unknown> | string | null
  hasPayload: number | boolean
  createdAt: Date
  updatedAt: Date
  fromUsername?: string
  toUsername?: string
}

interface FriendWorkoutRow extends RowDataPacket {
  id: number
  dayNumber: number
  dayTitle: string
  startTime: Date | string | null
  endTime: Date | string | null
  totalDuration: number | null
  completedSets: number
  primaryMuscles: unknown
  secondaryMuscles: unknown
}

interface InviteRow extends RowDataPacket {
  id: number
  from_user_id: number
  to_user_id: number
  from_workout_id: number | null
  status: string
  expires_at: Date
  created_at: Date
  from_username: string
  from_user_uuid: string
}

interface ParticipantRow extends RowDataPacket {
  userId: string
  sessionId: number | null
  username: string
  exerciseIndex: number
  setIndex: number
  exerciseName: string | null
  readyForNext: number
  exerciseNames: string[] | null
  lastUpdated: Date
}

const VALID_PERMISSION_TYPES: ReadonlySet<PermissionType> = new Set([
  "history",
  "analytics",
  "program",
  "joint_session",
  "watch_session",
  "trainer",
])

const INVITE_TTL_SECONDS = 120

/** Largest program snapshot a `program` grant may include (serialised JSON). */
export const MAX_PAYLOAD_BYTES = 256 * 1024
/** Grants one user may hold out to others, all types together. */
const MAX_GRANTS_PER_USER = 300
/** Of those, how many may be `program` grants, i.e. have a payload. */
const MAX_PROGRAM_GRANTS_PER_USER = 25
/**
 * With `?includePayload=true`, a permissions list inlines at most this many
 * payloads. Any others come back with `payload: null, hasPayload: true` and
 * are fetched one at a time from GET /permissions/:id/payload.
 */
const MAX_INLINE_PAYLOADS = 10

/**
 * MySQL's JSON type comes back from the driver already parsed. MariaDB's JSON
 * is LONGTEXT underneath and comes back as a string. Either way the client
 * gets an object.
 */
function parsePayload(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  /* v8 ignore next 7 -- only an older MariaDB that sends JSON without its type metadata reaches this */
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return v as Record<string, unknown>
}

// The pair is stored canonically (user_id = LEAST, friend_id = GREATEST), so
// checking a live friendship against a grant is one equality per column.
const ACCEPTED_FRIENDSHIP_JOIN = `JOIN friendships f
       ON f.status = 'accepted'
      AND f.user_id = LEAST(sp.from_user_id, sp.to_user_id)
      AND f.friend_id = GREATEST(sp.from_user_id, sp.to_user_id)`

export async function grantPermission(
  fromUserId: number,
  toUserId: number,
  permissionType: PermissionType,
  payload: Record<string, unknown> | null = null,
): Promise<number> {
  if (!VALID_PERMISSION_TYPES.has(permissionType))
    throw new ValidationError(`Invalid permission type: ${permissionType}`)

  // Only a program grant has anything to carry. Any other type's payload was
  // stored and then listed back verbatim: 2 MB of arbitrary JSON per grant.
  if (permissionType !== "program") payload = null

  // Re-granting an existing triple only replaces its payload, so it never
  // counts against the caps.
  const [[counts]] = await pool.execute<
    (RowDataPacket & { total: number; programs: number; existing: number })[]
  >(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(permission_type = 'program'), 0) AS programs,
            COALESCE(SUM(to_user_id = ? AND permission_type = ?), 0) AS existing
     FROM sharing_permissions WHERE from_user_id = ?`,
    [toUserId, permissionType, fromUserId],
  )
  if (!Number(counts.existing)) {
    if (Number(counts.total) >= MAX_GRANTS_PER_USER)
      throw new AppError(
        `You can hold at most ${MAX_GRANTS_PER_USER} sharing permissions`,
        409,
        null,
        "TOO_MANY_GRANTS",
      )
    if (
      permissionType === "program" &&
      Number(counts.programs) >= MAX_PROGRAM_GRANTS_PER_USER
    )
      throw new AppError(
        `You can share your program with at most ${MAX_PROGRAM_GRANTS_PER_USER} friends`,
        409,
        null,
        "TOO_MANY_GRANTS",
      )
  }

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type, payload)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), payload = VALUES(payload)`,
    [
      fromUserId,
      toUserId,
      permissionType,
      payload ? JSON.stringify(payload) : null,
    ],
  )
  // LAST_INSERT_ID(id) on the duplicate branch means insertId is the existing
  // row's id, so re-granting doesn't need a second SELECT.
  return result.insertId
}

export async function revokePermission(
  userId: number,
  permissionId: number,
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM sharing_permissions WHERE id = ? AND from_user_id = ?`,
    [permissionId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Permission")
}

/**
 * Permissions this user granted to others ("granted") or that others granted
 * to them ("received"), the same query mirrored across the two user columns.
 *
 * The payload (a whole program snapshot) is NOT selected here: 500 rows of it
 * was up to a gigabyte in one response. Each row says `hasPayload`, and the
 * payload itself comes from getPermissionPayload or, with `includePayload`,
 * inlined for the first MAX_INLINE_PAYLOADS rows that have one.
 *
 * The friendship join is not belt-and-braces: removeFriend and blockUser both
 * delete the grant rows in the same transaction, so there is no reachable
 * orphan today, but every other grant-backed read re-proves the friendship at
 * query time and this one would be the exception that leaks if any future
 * path drops a friendship without tearing grants down.
 */
export async function getPermissions(
  userId: number,
  direction: "granted" | "received",
  { includePayload = false }: { includePayload?: boolean } = {},
): Promise<Permission[]> {
  const [self, other] =
    direction === "granted"
      ? ["from_user_id", "to_user_id"]
      : ["to_user_id", "from_user_id"]
  const label = direction === "granted" ? "to" : "from"
  const [rows] = await pool.execute<PermissionRow[]>(
    `SELECT sp.id, u.uuid AS ${label}UserId, sp.permission_type AS permissionType,
            NULL AS payload, sp.payload IS NOT NULL AS hasPayload,
            sp.created_at AS createdAt, sp.updated_at AS updatedAt, u.username AS ${label}Username
     FROM sharing_permissions sp JOIN users u ON u.id = sp.${other}
     ${ACCEPTED_FRIENDSHIP_JOIN}
     WHERE sp.${self} = ? ORDER BY sp.permission_type, sp.created_at DESC LIMIT 500`,
    [userId],
  )
  const perms: Permission[] = rows.map((r) => ({
    ...r,
    payload: null,
    hasPayload: !!r.hasPayload,
  }))
  if (!includePayload) return perms

  // ids come from the query above, never from the request.
  const inline = perms.filter((p) => p.hasPayload).slice(0, MAX_INLINE_PAYLOADS)
  if (inline.length === 0) return perms
  const [payloads] = await pool.execute<
    (RowDataPacket & { id: number; payload: unknown })[]
  >(
    `SELECT id, payload FROM sharing_permissions
     WHERE id IN (${inline.map(() => "?").join(",")})`,
    inline.map((p) => p.id),
  )
  const byId = new Map(payloads.map((p) => [p.id, parsePayload(p.payload)]))
  return perms.map((p) => (byId.has(p.id) ? { ...p, payload: byId.get(p.id)! } : p))
}

/**
 * One grant's payload, for either end of it (the granter or the grantee),
 * and only while the two are still friends. Null when the caller is neither
 * or the grant is gone.
 */
export async function getPermissionPayload(
  userId: number,
  permissionId: number,
): Promise<{ payload: Record<string, unknown> | null } | null> {
  const [rows] = await pool.execute<(RowDataPacket & { payload: unknown })[]>(
    `SELECT sp.payload FROM sharing_permissions sp
     ${ACCEPTED_FRIENDSHIP_JOIN}
     WHERE sp.id = ? AND ? IN (sp.from_user_id, sp.to_user_id)`,
    [permissionId, userId],
  )
  return rows[0] ? { payload: parsePayload(rows[0].payload) } : null
}

/**
 * Who a user's live workout reaches: friends holding `watch_session` (they
 * get live_set_recorded and the session start/end pushes) and trainers (they
 * get trainee_set_recorded). Both need a live friendship as well as the grant,
 * otherwise a stale grant keeps sending events to someone the user
 * already unfriended.
 *
 * One query for both audiences. Recording a set used to run the same
 * grant+friendship join twice: once from a raw query in workouts.routes.ts,
 * once here, on the hottest write path the server has.
 */
interface LiveAudienceRow extends RowDataPacket {
  uuid: string
  username: string
  permissionType: "watch_session" | "trainer"
}

export async function getLiveAudience(
  userId: number,
  types: "watchers" | "all" = "all",
): Promise<LiveAudienceRow[]> {
  const [rows] = await pool.execute<LiveAudienceRow[]>(
    `SELECT u.uuid, u.username, sp.permission_type AS permissionType
     FROM sharing_permissions sp
     JOIN users u ON u.id = sp.to_user_id
     ${ACCEPTED_FRIENDSHIP_JOIN}
     WHERE sp.from_user_id = ? AND sp.permission_type IN (?, ?)`,
    [userId, "watch_session", types === "all" ? "trainer" : "watch_session"],
  )
  return rows
}

interface FriendAccess {
  id: number
  uuid: string
  /** An accepted friendship with the viewer. */
  friends: boolean
  /** The friend has granted the viewer `permission`. */
  granted: boolean
}

/**
 * Resolve a friend's uuid and check the friendship and one grant, in one
 * round trip. Friend-scoped routes used to pay three (the uuid lookup, then
 * the friendship and the grant) before doing any work, and the live-watch
 * route runs on every poll. 400 for a malformed uuid, 404 for no such user,
 * as requireUser does. The two booleans are left to the caller so each route
 * keeps its own wording.
 */
export async function resolveFriendAccess(
  viewerId: number,
  value: unknown,
  name: string,
  permission: PermissionType | null,
): Promise<FriendAccess> {
  const uuid = parseUuidParam(value, name)
  const [rows] = await pool.execute<
    (RowDataPacket & { id: number; friends: number; granted: number })[]
  >(
    `SELECT u.id,
       EXISTS(SELECT 1 FROM friendships f
               WHERE f.user_id = LEAST(u.id, ?) AND f.friend_id = GREATEST(u.id, ?)
                 AND f.status = 'accepted') AS friends,
       EXISTS(SELECT 1 FROM sharing_permissions sp
               WHERE sp.from_user_id = u.id AND sp.to_user_id = ?
                 AND sp.permission_type = ?) AS granted
     FROM users u WHERE u.uuid = ?`,
    [viewerId, viewerId, viewerId, permission ?? "", uuid],
  )
  if (!rows[0]) throw new NotFoundError("User")
  return {
    id: rows[0].id,
    uuid,
    friends: !!rows[0].friends,
    granted: !!rows[0].granted,
  }
}

// Muscle groups belong to the program day, not to the workout, same LEFT JOIN
// the owner's own history uses, so a friend sees the same labels they do.
const FRIEND_WORKOUT_COLS = `w.id, w.day_number AS dayNumber, w.day_title AS dayTitle,
       w.start_time AS startTime, w.end_time AS endTime,
       w.total_duration AS totalDuration, w.completed_sets AS completedSets,
       pd.primary_muscles AS primaryMuscles,
       pd.secondary_muscles AS secondaryMuscles
     FROM workouts w LEFT JOIN program_days pd ON pd.id = w.program_day_id`

const withMuscles = (w: FriendWorkoutRow) => ({
  ...w,
  primaryMuscles: parseMuscleGroups(w.primaryMuscles),
  secondaryMuscles: parseMuscleGroups(w.secondaryMuscles),
})

// The fields a friend sees for one set, shared by the detail route and the
// list's includeTimings, so the two can't drift apart.
const FRIEND_SET_COLS = `ws.id, ws.workout_id AS sessionId, ws.set_index AS setIndex,
            ws.weight, ws.reps,
            ws.set_duration AS setDuration, ws.rest_time AS restTime,
            ws.machine_name AS machineName, ws.rir,
            e.name AS exerciseName,
            ${EXERCISE_MUSCLE_COLS}`

/**
 * A friend's history, newest first. With `includeTimings`, every session also
 * includes the same `setTimings` the detail route returns, fetched in one IN
 * query, because the app's friend Analytics tab used to make one detail call
 * per session and could spend the per-IP rate limit in a couple of opens.
 */
/**
 * A friend's history, newest first, paged like the owner's own
 * (GET /api/sessions): `before` is the nextCursor of the previous page. It was
 * one capped page before, so anything past the newest 200 could not be fetched.
 */
export async function getFriendSessions(
  friendId: number,
  limit = 60,
  includeTimings = false,
  before: HistoryCursor | null = null,
) {
  const [rows] = await pool.execute<FriendWorkoutRow[]>(
    `SELECT ${FRIEND_WORKOUT_COLS}
     WHERE w.user_id = ? AND w.is_demo = 0
       ${before ? "AND (w.start_time < ? OR (w.start_time = ? AND w.id < ?))" : ""}
     ORDER BY w.start_time DESC, w.id DESC LIMIT ?`,
    before
      ? [friendId, before.startTime, before.startTime, before.id, limit]
      : [friendId, limit],
  )
  const sessions = rows.map(withMuscles)
  if (!includeTimings) return sessions
  if (sessions.length === 0) return []

  // ids come from the query above, never from the request.
  const ids = sessions.map((s) => s.id)
  const [sets] = await pool.execute<(RowDataPacket & { sessionId: number })[]>(
    `SELECT ${FRIEND_SET_COLS}
     ${SET_FROM}
     WHERE ws.workout_id IN (${ids.map(() => "?").join(",")})
     ORDER BY ws.workout_id ASC, ws.created_at ASC, ws.id ASC`,
    ids,
  )
  const bySession = new Map<number, RowDataPacket[]>()
  for (const { sessionId, ...set } of sets) {
    const list = bySession.get(sessionId)
    if (list) list.push(set)
    else bySession.set(sessionId, [set])
  }
  // Every session gets the field, [] included: the app reads a missing
  // setTimings as an older server and falls back to per-session calls.
  return sessions.map((s) => ({ ...s, setTimings: bySession.get(s.id) ?? [] }))
}

export async function getFriendSessionDetails(
  friendId: number,
  sessionId: number,
) {
  const [rows] = await pool.execute<FriendWorkoutRow[]>(
    `SELECT ${FRIEND_WORKOUT_COLS} WHERE w.id = ? AND w.user_id = ? AND w.is_demo = 0`,
    [sessionId, friendId],
  )
  if (!rows[0]) return null

  const [sets] = await pool.execute<RowDataPacket[]>(
    `SELECT ${FRIEND_SET_COLS}
     ${SET_FROM}
     WHERE ws.workout_id = ? ORDER BY ws.created_at ASC, ws.id ASC`,
    [sessionId],
  )
  // sessionId is selected for the batched list query. The detail route never
  // carried it per set, so it stays off here.
  return {
    ...withMuscles(rows[0]),
    setTimings: sets.map(({ sessionId: _, ...set }) => set),
  }
}

export async function createJointInvite(
  fromUserId: number,
  toUserId: number,
  fromSessionId: number | null = null,
): Promise<number> {
  await pool.execute(
    `UPDATE joint_session_invites SET status = 'declined' WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
    [fromUserId, toUserId],
  )
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO joint_session_invites (from_user_id, to_user_id, from_workout_id, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [fromUserId, toUserId, fromSessionId, INVITE_TTL_SECONDS],
  )
  return result.insertId
}

export async function getInvite(inviteId: number): Promise<InviteRow | null> {
  const [rows] = await pool.execute<InviteRow[]>(
    `SELECT i.id, i.from_user_id, i.to_user_id, i.from_workout_id, i.status, i.expires_at, i.created_at, u.username AS from_username,
            u.uuid AS from_user_uuid
     FROM joint_session_invites i JOIN users u ON u.id = i.from_user_id WHERE i.id = ?`,
    [inviteId],
  )
  return rows[0] ?? null
}

export async function acceptInvite(
  inviteId: number,
  acceptingUserId: number,
  acceptingSessionId: number | null = null,
): Promise<{ jointSessionId: number }> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<InviteRow[]>(
      `SELECT * FROM joint_session_invites WHERE id = ? AND to_user_id = ? AND status = 'pending' AND expires_at > NOW() FOR UPDATE`,
      [inviteId, acceptingUserId],
    )
    if (!rows[0])
      throw new ConflictError("Invite not found, already used, or expired")
    const invite = rows[0]

    await conn.execute(
      `UPDATE joint_session_invites SET status = 'accepted' WHERE id = ?`,
      [inviteId],
    )
    // created_by is what gives this table a foreign key: the session row
    // cascades away with the inviter instead of being swept up later.
    const [jsResult] = await conn.execute<ResultSetHeader>(
      `INSERT INTO joint_sessions (created_by) VALUES (?)`,
      [invite.from_user_id],
    )
    const jointSessionId = jsResult.insertId

    // No username column: it is the same string as users.username and is
    // joined in on read.
    await conn.execute(
      `INSERT INTO joint_session_participants (joint_session_id, user_id, workout_id)
       VALUES (?, ?, ?), (?, ?, ?)`,
      [
        jointSessionId,
        invite.from_user_id,
        invite.from_workout_id,
        jointSessionId,
        acceptingUserId,
        acceptingSessionId,
      ],
    )
    return { jointSessionId }
  })
}

export async function declineInvite(
  inviteId: number,
  decliningUserId: number,
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE joint_session_invites SET status = 'declined' WHERE id = ? AND to_user_id = ? AND status = 'pending'`,
    [inviteId, decliningUserId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Invite")
}

export async function getJointSession(
  jointSessionId: number,
): Promise<JointSession | null> {
  const [sessions] = await pool.execute<RowDataPacket[]>(
    `SELECT id, status, created_at FROM joint_sessions WHERE id = ?`,
    [jointSessionId],
  )
  if (!sessions[0]) return null

  const [participants] = await pool.execute<ParticipantRow[]>(
    // exerciseName is element exercise_index of the list, not a column of its
    // own: one piece of state, read two ways.
    `SELECT u.uuid AS userId, p.workout_id AS sessionId, u.username,
            p.exercise_index AS exerciseIndex, p.set_index AS setIndex,
            JSON_UNQUOTE(JSON_EXTRACT(p.exercise_names,
              CONCAT('$[', p.exercise_index, ']'))) AS exerciseName,
            p.ready_for_next AS readyForNext, p.exercise_names AS exerciseNames,
            p.last_updated AS lastUpdated
     FROM joint_session_participants p JOIN users u ON u.id = p.user_id
     WHERE p.joint_session_id = ?`,
    [jointSessionId],
  )

  return {
    id: sessions[0].id,
    status: sessions[0].status,
    createdAt: sessions[0].created_at,
    participants: participants.map(
      (p): JointSessionParticipant => ({ ...p, readyForNext: !!p.readyForNext }),
    ),
  }
}

/**
 * Returns the values actually written, so the WS fan-out broadcasts what the
 * DB holds. Broadcasting req.body instead sent partners an exerciseIndex of
 * -5 or "banana" while the row held 0, and a re-read then disagreed with the
 * live event.
 */
export async function updateParticipantProgress(
  jointSessionId: number,
  userId: number,
  progress: ParticipantProgress,
): Promise<{
  exerciseIndex: number
  setIndex: number
  readyForNext: boolean
  exerciseName: string | null
  exerciseNames: string[] | null
}> {
  // ck_jsp_index: both indices are >= 0 integers, and the columns are NOT NULL.
  // Raw JSON from a socket (or a REST body): non-numeric values become 0
  // instead of a 1264/1366 error.
  const cleanIndex = (v: unknown): number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0
  const exerciseIndex = cleanIndex(progress.exerciseIndex)
  const setIndex = cleanIndex(progress.setIndex)
  const readyForNext = !!progress.readyForNext
  const assignments = [
    "exercise_index = ?",
    "set_index = ?",
    "ready_for_next = ?",
  ]
  const params: (string | number)[] = [
    exerciseIndex,
    setIndex,
    readyForNext ? 1 : 0,
  ]

  // A client that knows the whole day's list sends exerciseNames. One that only
  // knows what it is doing right now sends exerciseName, which is stored in its own
  // slot (JSON_SET appends when the index is past the end).
  if (progress.exerciseNames) {
    assignments.push("exercise_names = JSON_EXTRACT(?, '$')")
    params.push(JSON.stringify(progress.exerciseNames))
  } else if (progress.exerciseName) {
    assignments.push(
      "exercise_names = JSON_SET(exercise_names, CONCAT('$[', ?, ']'), ?)",
    )
    params.push(exerciseIndex, progress.exerciseName)
  }

  // The status join is the one authorization gate both progress paths share
  // (the WS `push_joint_progress` handler and PATCH .../progress), so a session
  // ended by an unfriend or a block stops broadcasting on the next push rather
  // than running until one side happens to send `leave_joint_session`.
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE joint_session_participants p
       JOIN joint_sessions s ON s.id = p.joint_session_id
     SET ${assignments.map((a) => `p.${a}`).join(", ")}
     WHERE p.joint_session_id = ? AND p.user_id = ? AND s.status = 'active'`,
    [...params, jointSessionId, userId],
  )
  if (result.affectedRows === 0)
    throw new NotFoundError("Active joint session for this participant")

  return {
    exerciseIndex,
    setIndex,
    readyForNext,
    exerciseName: progress.exerciseNames
      ? (progress.exerciseNames[exerciseIndex] ?? null)
      : (progress.exerciseName ?? null),
    exerciseNames: progress.exerciseNames ?? null,
  }
}

/**
 * End a joint session on behalf of one of its participants, and return the
 * other participant's uuid (null when there is none any more) so the caller
 * can tell them. The HTTP leave route and the WS `leave_joint_session`
 * handler both come through here. They used to run their own SQL and tell
 * the partner with different events.
 */
export async function endJointSession(
  jointSessionId: number,
  userId: number,
): Promise<{ partnerId: string | null }> {
  const [rows] = await pool.execute<(RowDataPacket & { partnerId: string | null })[]>(
    `SELECT u.uuid AS partnerId
     FROM joint_session_participants me
     LEFT JOIN joint_session_participants o
       ON o.joint_session_id = me.joint_session_id AND o.user_id <> me.user_id
     LEFT JOIN users u ON u.id = o.user_id
     WHERE me.joint_session_id = ? AND me.user_id = ?`,
    [jointSessionId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Joint session participant")
  await pool.execute(`UPDATE joint_sessions SET status = 'ended' WHERE id = ?`, [
    jointSessionId,
  ])
  return { partnerId: rows[0].partnerId }
}

interface ActiveSessionStatus {
  hasActiveSession: boolean
  sessionId: number | null
  /** ISO start of the active workout, or null when there is none. */
  startedAt: string | null
}

const NO_ACTIVE_SESSION: ActiveSessionStatus = {
  hasActiveSession: false,
  sessionId: null,
  startedAt: null,
}

// end_time is not in idx_w_user_start, so with no active workout (the normal
// state) an unbounded scan walked every workout the user had ever logged
// before giving up. sessionCleanup ends anything idle >30min, so a workout
// older than a day is always closed and this bound changes no behaviour.
const ACTIVE_WORKOUT_WHERE = `end_time IS NULL AND start_time > NOW() - INTERVAL 1 DAY`

/**
 * Returns whether the user has an active (non-ended) workout.
 * Pure read: does not mutate any rows.
 */
export async function getUserActiveSessionStatus(
  userId: number,
): Promise<ActiveSessionStatus> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, start_time FROM workouts
     WHERE user_id = ? AND ${ACTIVE_WORKOUT_WHERE}
     ORDER BY start_time DESC LIMIT 1`,
    [userId],
  )
  return rows[0]
    ? {
        hasActiveSession: true,
        sessionId: rows[0].id,
        startedAt: parseMySQLDate(rows[0].start_time).toISOString(),
      }
    : { ...NO_ACTIVE_SESSION }
}

/**
 * getUserActiveSessionStatus for many friends at once, keyed by uuid. The
 * Friends screen and every Home friends widget used to make one call per
 * friend. Uuids that aren't the caller's accepted friends (or aren't users at
 * all) are simply absent, and the app reads an absent id as no active session.
 * Two queries whatever the number of ids. The caller caps that at 100.
 */
export async function getFriendsActiveSessionStatuses(
  viewerId: number,
  friendUuids: string[],
): Promise<Record<string, ActiveSessionStatus>> {
  if (friendUuids.length === 0) return {}

  // query(), not execute(): `IN (?)` expands the array client-side, so up to
  // 100 ids don't prepare up to 100 statement shapes per connection.
  // Whether a friend is mid-workout is only shown to friends they granted a
  // live permission. Everyone else always reads "no active session".
  const [friends] = await pool.query<
    (RowDataPacket & { id: number; uuid: string; shared: number })[]
  >(
    `SELECT u.id, u.uuid,
       EXISTS(SELECT 1 FROM sharing_permissions sp
               WHERE sp.from_user_id = u.id AND sp.to_user_id = ?
                 AND sp.permission_type IN ('watch_session', 'joint_session', 'trainer')) AS shared
     FROM users u
     JOIN friendships f
       ON f.user_id = LEAST(?, u.id) AND f.friend_id = GREATEST(?, u.id)
      AND f.status = 'accepted'
     WHERE u.uuid IN (?)`,
    [viewerId, viewerId, viewerId, friendUuids],
  )
  if (friends.length === 0) return {}

  const statuses: Record<string, ActiveSessionStatus> = {}
  const uuidById = new Map<number, string>()
  for (const f of friends) {
    if (f.shared) uuidById.set(f.id, f.uuid)
    statuses[f.uuid] = { ...NO_ACTIVE_SESSION }
  }
  if (uuidById.size === 0) return statuses

  // ids come from the friendship query above, never from the request.
  const [active] = await pool.query<
    (RowDataPacket & { id: number; user_id: number; start_time: string })[]
  >(
    `SELECT id, user_id, start_time FROM workouts
     WHERE user_id IN (?)
       AND ${ACTIVE_WORKOUT_WHERE}
     ORDER BY start_time DESC`,
    [[...uuidById.keys()]],
  )
  // Newest first, so the first row per user is the one the single-friend
  // route would have picked.
  const seen = new Set<number>()
  for (const w of active) {
    if (seen.has(w.user_id)) continue
    seen.add(w.user_id)
    statuses[uuidById.get(w.user_id)!] = {
      hasActiveSession: true,
      sessionId: w.id,
      startedAt: parseMySQLDate(w.start_time).toISOString(),
    }
  }
  return statuses
}

/**
 * Housekeeping for the joint-session tables, run by the 5-minute cleanup job.
 * Nothing used to remove any of it:
 *   - invites expire after 120s and nothing reads one after it expires.
 *   - a session both apps died in remained 'active' forever (no workout lasts
 *     a day: sessionCleanup ends anything idle 30 min), and kept accepting
 *     progress pushes.
 *   - ended sessions and their participant rows (ON DELETE CASCADE) piled up.
 * Each statement is batched so one run never holds locks for long.
 */
export async function purgeJointSessions(batch = 1000): Promise<{
  invites: number
  ended: number
  deleted: number
}> {
  const limit = Number(batch) | 0
  const [invites] = await pool.execute<ResultSetHeader>(
    `DELETE FROM joint_session_invites
     WHERE expires_at < NOW() - INTERVAL 1 DAY LIMIT ${limit}`,
  )
  const [ended] = await pool.execute<ResultSetHeader>(
    `UPDATE joint_sessions SET status = 'ended'
     WHERE status = 'active' AND created_at < NOW() - INTERVAL 1 DAY LIMIT ${limit}`,
  )
  const [deleted] = await pool.execute<ResultSetHeader>(
    `DELETE FROM joint_sessions
     WHERE status = 'ended' AND created_at < NOW() - INTERVAL 7 DAY LIMIT ${limit}`,
  )
  return {
    invites: invites.affectedRows,
    ended: ended.affectedRows,
    deleted: deleted.affectedRows,
  }
}
