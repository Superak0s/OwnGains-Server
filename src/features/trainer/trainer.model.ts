import { pool, parseMySQLDate, withTransaction } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  ACCEPTED_FRIENDSHIP_JOIN,
  MAX_PENDING_SENT,
} from "@/features/social/friends/friends.model.js"

/** A pending trainer request as the API returns it. */
export interface TrainerRequest {
  id: string
  fromUserId: string
  fromUsername: string
  toUserId: string
  toUsername: string
  includeTracking: boolean
  createdAt: string
}

/** One row of GET /api/trainer/clients. */
export interface TrainerClient {
  userId: string
  username: string
  lastWorkoutAt: string | null
  sessionsThisWeek: number
  activeProgramDayCount: number | null
  hasTrackingAccess: boolean
}

interface RequestRow extends RowDataPacket {
  id: number
  fromUserId: string
  fromUsername: string
  toUserId: string
  toUsername: string
  includeTracking: number
  createdAt: string
}

interface ClientRow extends RowDataPacket {
  userId: string
  username: string
  lastWorkoutAt: string | null
  sessionsThisWeek: number
  activeProgramDayCount: number | null
  hasTrackingAccess: number
}

const REQUEST_SELECT = `SELECT r.id, f.uuid AS fromUserId, f.username AS fromUsername,
       t.uuid AS toUserId, t.username AS toUsername,
       r.include_tracking AS includeTracking, r.created_at AS createdAt
     FROM trainer_requests r
     JOIN users f ON f.id = r.from_user_id
     JOIN users t ON t.id = r.to_user_id`

const iso = (v: string | null) => (v == null ? null : parseMySQLDate(v).toISOString())

const toRequest = (r: RequestRow): TrainerRequest => ({
  ...r,
  id: String(r.id),
  includeTracking: !!r.includeTracking,
  createdAt: iso(r.createdAt)!,
})

async function isBlocked(
  db: Pick<PoolConnection, "execute">,
  a: number,
  b: number,
): Promise<boolean> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
     LIMIT 1`,
    [a, b, b, a],
  )
  return rows.length > 0
}

/**
 * Asks another user to grant the caller `trainer`, or a current client to add `tracking`.
 * The two need not be friends.
 *
 * @param fromUserId - Numeric id of the would-be trainer.
 * @param target - The would-be client, by username or uuid.
 * @param includeTracking - Whether the trainer also asks for Tracking Access. The client decides on accept.
 * @throws NotFoundError for no such (active) user, ValidationError for the caller themselves,
 *   ForbiddenError for a block either way, ConflictError when already pending or everything asked for is granted.
 */
export async function createTrainerRequest(
  fromUserId: number,
  target: { username: string } | { uuid: string },
  includeTracking: boolean,
): Promise<TrainerRequest> {
  const [col, value] =
    "username" in target ? ["username", target.username] : ["uuid", target.uuid]
  // A suspended account answers like a missing one, as on friend requests.
  const [users] = await pool.execute<(RowDataPacket & { id: number })[]>(
    `SELECT id FROM users WHERE ${col} = ? AND disabled_at IS NULL`,
    [value],
  )
  const toUserId = users[0]?.id
  if (!toUserId) throw new NotFoundError("User")
  if (toUserId === fromUserId)
    throw new ValidationError("Cannot send a trainer request to yourself")
  // One message both ways, so the sender can't tell who blocked whom.
  if (await isBlocked(pool, fromUserId, toUserId))
    throw new ForbiddenError("Cannot send a trainer request to this user")

  const [granted] = await pool.execute<(RowDataPacket & { type: string })[]>(
    `SELECT permission_type AS type FROM sharing_permissions
     WHERE from_user_id = ? AND to_user_id = ? AND permission_type IN ('trainer', 'tracking')`,
    [toUserId, fromUserId],
  )
  const types = granted.map((g) => g.type)
  // An existing trainer may still ask for Tracking Access, which is never granted with Trainer Access.
  if (types.includes("trainer") && (!includeTracking || types.includes("tracking")))
    throw new ConflictError("You are already this user's trainer", "ALREADY_TRAINER")

  // Anyone can ask anyone, so the same spam cap as friend requests.
  const [[pending]] = await pool.execute<(RowDataPacket & { n: number })[]>(
    `SELECT COUNT(*) AS n FROM trainer_requests WHERE from_user_id = ?`,
    [fromUserId],
  )
  if (Number(pending.n) >= MAX_PENDING_SENT)
    throw new AppError(
      `You have ${MAX_PENDING_SENT} trainer requests waiting. Wait for replies first`,
      429,
      null,
      "TOO_MANY_PENDING_REQUESTS",
    )

  let id: number
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO trainer_requests (from_user_id, to_user_id, include_tracking)
       VALUES (?, ?, ?)`,
      [fromUserId, toUserId, includeTracking ? 1 : 0],
    )
    id = result.insertId
  } catch (err) {
    if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err
    throw new ConflictError("Trainer request already pending", "REQUEST_PENDING")
  }
  const [rows] = await pool.execute<RequestRow[]>(`${REQUEST_SELECT} WHERE r.id = ?`, [id])
  return toRequest(rows[0])
}

/**
 * Pending trainer requests addressed to the caller, or sent by them.
 *
 * @param userId - Numeric id of the caller.
 * @param direction - `received` or `sent`.
 */
export async function listTrainerRequests(
  userId: number,
  direction: "received" | "sent",
): Promise<TrainerRequest[]> {
  const [rows] = await pool.execute<RequestRow[]>(
    `${REQUEST_SELECT}
     WHERE r.${direction === "received" ? "to_user_id" : "from_user_id"} = ?
     ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
    [userId],
  )
  return rows.map(toRequest)
}

/**
 * Accepts a request addressed to the caller: makes the pair friends if they
 * aren't, grants the sender `trainer` (and `tracking` when the client chose
 * to) and deletes the request, in one transaction.
 *
 * @param userId - Numeric id of the recipient (the new client).
 * @param requestId - `trainer_requests.id`.
 * @param includeTracking - The client's own choice, whatever the request asked for.
 * @throws NotFoundError when no such request is addressed to the caller, ForbiddenError for a block.
 */
export async function acceptTrainerRequest(
  userId: number,
  requestId: number,
  includeTracking: boolean,
): Promise<void> {
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute<(RowDataPacket & { trainerId: number })[]>(
      `SELECT from_user_id AS trainerId FROM trainer_requests
       WHERE id = ? AND to_user_id = ? FOR UPDATE`,
      [requestId, userId],
    )
    const trainerId = rows[0]?.trainerId
    if (!trainerId) throw new NotFoundError("Trainer request")
    if (await isBlocked(conn, userId, trainerId))
      throw new ForbiddenError("Cannot accept a trainer request from this user")

    // A pending friend request between the pair is accepted along the way.
    await conn.execute(
      `INSERT INTO friendships (user_id, friend_id, requested_by, status, accepted_at)
       VALUES (LEAST(?, ?), GREATEST(?, ?), ?, 'accepted', NOW())
       ON DUPLICATE KEY UPDATE status = 'accepted', accepted_at = COALESCE(accepted_at, NOW())`,
      [userId, trainerId, userId, trainerId, trainerId],
    )
    await conn.execute(
      `DELETE FROM friend_request_cooldowns
       WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)`,
      [userId, trainerId, trainerId, userId],
    )
    // The same row POST /api/sharing/permissions creates.
    for (const type of includeTracking ? ["trainer", "tracking"] : ["trainer"])
      await conn.execute(
        `INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [userId, trainerId, type],
      )
    await conn.execute(`DELETE FROM trainer_requests WHERE id = ?`, [requestId])
  })
}

/**
 * Declines a request addressed to the caller by deleting it.
 *
 * @throws NotFoundError when no such request is addressed to the caller.
 */
export async function rejectTrainerRequest(userId: number, requestId: number): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM trainer_requests WHERE id = ? AND to_user_id = ?`,
    [requestId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Trainer request")
}

/**
 * Withdraws a pending request the caller sent.
 *
 * @throws NotFoundError when the caller sent no such pending request.
 */
export async function cancelTrainerRequest(userId: number, requestId: number): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM trainer_requests WHERE id = ? AND from_user_id = ?`,
    [requestId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Trainer request")
}

/**
 * Stops coaching a client by dropping their `trainer` grant to the caller, and
 * the `tracking` grant that only exists on top of it. The friendship stays.
 *
 * @throws NotFoundError when that user never made the caller their trainer.
 */
export async function removeClient(trainerId: number, clientUuid: string): Promise<void> {
  await withTransaction(async (conn) => {
    const [result] = await conn.execute<ResultSetHeader>(
      `DELETE sp FROM sharing_permissions sp JOIN users u ON u.id = sp.from_user_id
       WHERE u.uuid = ? AND sp.to_user_id = ? AND sp.permission_type = 'trainer'`,
      [clientUuid, trainerId],
    )
    if (result.affectedRows === 0) throw new NotFoundError("Client")
    await conn.execute(
      `DELETE sp FROM sharing_permissions sp JOIN users u ON u.id = sp.from_user_id
       WHERE u.uuid = ? AND sp.to_user_id = ? AND sp.permission_type = 'tracking'`,
      [clientUuid, trainerId],
    )
  })
}

/**
 * Everyone who has granted the caller `trainer` and is still a friend (the same
 * test trainer mode applies), with their recent activity. The caller's own demo
 * friends count even though demo accounts are stored disabled.
 *
 * @param trainerId - Numeric id of the caller.
 * @param weekStart - `YYYY-MM-DD`. Completed workouts that started on or after it count as this week.
 */
export async function getClients(trainerId: number, weekStart: string): Promise<TrainerClient[]> {
  // GROUP BY p.id makes the program subquery NULL, not 0, when there's no program.
  const [rows] = await pool.execute<ClientRow[]>(
    `SELECT u.uuid AS userId, u.username,
       (SELECT MAX(w.start_time) FROM workouts w
         WHERE w.user_id = u.id AND w.end_time IS NOT NULL AND w.is_demo = 0) AS lastWorkoutAt,
       (SELECT COUNT(*) FROM workouts w
         WHERE w.user_id = u.id AND w.end_time IS NOT NULL AND w.is_demo = 0
           AND w.start_time >= ?) AS sessionsThisWeek,
       (SELECT COUNT(pd.id) FROM programs p
          LEFT JOIN program_days pd ON pd.program_id = p.id
         WHERE p.user_id = u.id GROUP BY p.id) AS activeProgramDayCount,
       EXISTS (SELECT 1 FROM sharing_permissions t
         WHERE t.from_user_id = sp.from_user_id AND t.to_user_id = sp.to_user_id
           AND t.permission_type = 'tracking') AS hasTrackingAccess
     FROM sharing_permissions sp
     JOIN users u ON u.id = sp.from_user_id
      AND (u.disabled_at IS NULL OR u.demo_owner_id = sp.to_user_id)
     ${ACCEPTED_FRIENDSHIP_JOIN}
     WHERE sp.to_user_id = ? AND sp.permission_type = 'trainer'
     ORDER BY u.username LIMIT 500`,
    [weekStart, trainerId],
  )
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    lastWorkoutAt: iso(r.lastWorkoutAt),
    sessionsThisWeek: Number(r.sessionsThisWeek),
    activeProgramDayCount:
      r.activeProgramDayCount == null ? null : Number(r.activeProgramDayCount),
    hasTrackingAccess: !!Number(r.hasTrackingAccess),
  }))
}
