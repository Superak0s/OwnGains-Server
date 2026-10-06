import { pool, formatDateForMySQL, parseMySQLDate, withTransaction } from "@/config/database.js"
import type { Pool, PoolConnection } from "mysql2/promise"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  throwCheckViolation,
} from "@/middleware/errorHandler.js"

/** The pool, or a connection holding an open transaction. */
type Queryable = Pool | PoolConnection

/**
 * One recorded set as every read returns it. The pool runs with
 * `dateStrings: true`, so the DATETIME columns are strings.
 */
interface SetTiming {
  id: number
  sessionId: number
  exerciseId: number
  exerciseName: string
  exercisePrimaryMuscles: string[]
  exerciseSecondaryMuscles: string[]
  setIndex: number
  startTime: string
  endTime: string
  setDuration: number
  restTime: number | null
  weight: number
  reps: number
  note: string | null
  isWarmup: number
  rir: number | null
  machineName: string | null
}

export interface Session {
  id: number
  /** Owner's uuid. */
  userId: string
  dayNumber: number
  dayTitle: string
  primaryMuscles: string[]
  secondaryMuscles: string[]
  startTime: string
  endTime: string | null
  totalDuration: number | null
  completedSets: number
  split: string | null
  isDemo: boolean
  userName: string
  setTimings: SetTiming[]
}

interface RecordSetResult {
  id: number
  exerciseId: number
  setDuration: number
  restTime: number | null
  rir: number | null
  machineName: string | null
}

// The API speaks camelCase, MySQL speaks snake_case. Every workout/set read
// aliases its columns here so rows can go straight to res.json() without a
// mapping layer. Alias any new column the same way.
//
// The REST surface still calls a workout a "session" (mount: /api/sessions,
// field: sessionId) even though the tables are `workouts` / `workout_sets`.
// The rename was to stop "sessions" reading as login state next to
// refresh_tokens. It was not a wire break.
//
// primaryMuscles/secondaryMuscles are NOT columns on `workouts`: they are read
// through program_day_id, so editing a program day relabels its history instead
// of leaving stale copies behind. Every query using these columns must include
// WORKOUT_FROM's LEFT JOIN.
const WORKOUT_COLS = `w.id, wu.uuid AS userId, w.day_number AS dayNumber,
  w.day_title AS dayTitle, w.start_time AS startTime,
  w.end_time AS endTime, w.total_duration AS totalDuration,
  w.completed_sets AS completedSets, w.split, w.is_demo AS isDemo,
  pd.primary_muscles AS primaryMuscles, pd.secondary_muscles AS secondaryMuscles`

// LEFT, not INNER: program_day_id is ON DELETE SET NULL, so a workout whose
// program was deleted must still appear in history (with no muscle labels).
// `wu` supplies the owner's uuid, the only user id a response may include.
const WORKOUT_FROM = `FROM workouts w
  JOIN users wu ON wu.id = w.user_id
  LEFT JOIN program_days pd ON w.program_day_id = pd.id`

/**
 * The set owner's own muscle labels for the exercise when they have any, the
 * shared catalog's otherwise. Needs `uem` joined on the owner. See SET_FROM.
 */
export const EXERCISE_MUSCLE_COLS = `IF(JSON_LENGTH(uem.primary_muscles) > 0,
     uem.primary_muscles, e.primary_muscles) AS exercisePrimaryMuscles,
  IF(JSON_LENGTH(uem.secondary_muscles) > 0,
     uem.secondary_muscles, e.secondary_muscles) AS exerciseSecondaryMuscles`

/** FROM for every set read: the set, its exercise, and its owner's labels. */
export const SET_FROM = `FROM workout_sets ws
  JOIN exercises e ON ws.exercise_id = e.id
  JOIN workouts sw ON sw.id = ws.workout_id
  LEFT JOIN user_exercise_muscles uem
    ON uem.user_id = sw.user_id AND uem.exercise_id = ws.exercise_id`

const SET_COLS = `ws.id, ws.workout_id AS sessionId, ws.exercise_id AS exerciseId,
  ws.set_index AS setIndex,
  ws.start_time AS startTime, ws.end_time AS endTime,
  ws.set_duration AS setDuration, ws.rest_time AS restTime,
  ws.weight, ws.reps, ws.note, ws.is_warmup AS isWarmup, ws.rir,
  ws.machine_name AS machineName, e.name AS exerciseName,
  ${EXERCISE_MUSCLE_COLS}`

interface WorkoutRow extends RowDataPacket {
  id: number
  userId: string
  dayNumber: number
  dayTitle: string
  // JSON columns from program_days. mysql2 hands them back already parsed, and
  // NULL only when the workout has no program_day link.
  primaryMuscles: string[] | null
  secondaryMuscles: string[] | null
  startTime: Date | string
  endTime: Date | string | null
  totalDuration: number | null
  completedSets: number
  split: string | null
  userName: string
  username: string
  setCount?: number
}

/** A SET_COLS row: the same fields as SetTiming, as the driver types a row. */
interface WorkoutSetRow extends RowDataPacket, SetTiming {}

/**
 * Normalise a muscle-group JSON column to string[].
 *
 * `exercises` and `program_days` declare these columns NOT NULL DEFAULT
 * (JSON_ARRAY()), and mysql2 parses JSON columns for you, so a row value is
 * always an array. The only NULL that reaches here comes from a LEFT JOIN that
 * found no program day.
 */
export function parseMuscleGroups(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === "string")
    : []
}

/**
 * Catalog id for a name, creating the row on first sighting. The only copy of
 * this helper: the set paths and the program edits share it.
 *
 * Pass the transaction's connection when there is one, so the catalog write
 * commits or rolls back with the rest of the request. recordSetTiming calls it
 * only after its ownership check, so a POST to someone else's workout never
 * touches the shared catalog.
 */
export async function findOrCreateExercise(
  userId: number | null,
  name: string,
  primaryMuscles: string[] = [],
  secondaryMuscles: string[] = [],
  db: Queryable = pool,
): Promise<number> {
  // Hot path: this runs on every recorded set and the exercise almost always
  // exists already, so try a plain read first. The INSERT below writes a row
  // even when its ON DUPLICATE KEY branch is a no-op: a redo-log entry and a
  // row lock per set, for nothing. The caller's own labels come back with it,
  // so an unchanged label costs no write either.
  const [hit] = await db.execute<RowDataPacket[]>(
    `SELECT e.id, uem.primary_muscles AS ownPrimary,
            uem.secondary_muscles AS ownSecondary
     FROM exercises e
     LEFT JOIN user_exercise_muscles uem ON uem.exercise_id = e.id AND uem.user_id = ?
     WHERE e.name = ?`,
    [userId ?? 0, name],
  )
  let id: number
  // A user's labels are stored as their own only, never on the shared row:
  // the catalog's labels are every other user's fallback, and filling them
  // from a request let any account choose what everyone else saw.
  if (hit[0]) {
    id = hit[0].id
  } else {
    // First sighting of this name. LAST_INSERT_ID(id) makes the duplicate-key
    // branch report the existing row's id, which covers two concurrent
    // requests both missing the SELECT above. The id is read off this
    // statement's own OK packet: LAST_INSERT_ID is per connection, and the old
    // separate `SELECT LAST_INSERT_ID()` through the pool could run on another
    // connection and return another request's id (or 0), attaching the set to
    // a stranger's exercise.
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO exercises (name) VALUES (?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [name],
    )
    id = result.insertId
  }
  if (userId != null)
    await saveOwnMuscles(db, userId, id, primaryMuscles, secondaryMuscles, hit[0])
  return id
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Record the labels this user gave an exercise, as their own. An empty list
 * leaves that side alone (the app sends none when it doesn't know), and
 * labels matching what is stored cost no write, since this sits on the set path.
 */
export async function saveOwnMuscles(
  db: Queryable,
  userId: number,
  exerciseId: number,
  primaryMuscles: string[],
  secondaryMuscles: string[],
  current?: RowDataPacket,
): Promise<void> {
  const primaryChanged =
    primaryMuscles.length > 0 &&
    !sameList(primaryMuscles, parseMuscleGroups(current?.ownPrimary))
  const secondaryChanged =
    secondaryMuscles.length > 0 &&
    !sameList(secondaryMuscles, parseMuscleGroups(current?.ownSecondary))
  if (!primaryChanged && !secondaryChanged) return
  await db.execute(
    `INSERT INTO user_exercise_muscles
       (user_id, exercise_id, primary_muscles, secondary_muscles)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       primary_muscles = IF(JSON_LENGTH(VALUES(primary_muscles)) > 0,
                            VALUES(primary_muscles), primary_muscles),
       secondary_muscles = IF(JSON_LENGTH(VALUES(secondary_muscles)) > 0,
                              VALUES(secondary_muscles), secondary_muscles)`,
    [userId, exerciseId, JSON.stringify(primaryMuscles), JSON.stringify(secondaryMuscles)],
  )
}

/**
 * The program day this workout is running, or null when the user has no
 * program (or none covering this day number). This is the only place the link
 * is resolved. Muscle labels are then read through it forever.
 */
export async function findProgramDayId(
  userId: number,
  dayNumber: number,
): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT pd.id FROM program_days pd
     JOIN programs p ON pd.program_id = p.id
     WHERE p.user_id = ? AND pd.day_number = ?`,
    [userId, dayNumber],
  )
  return rows[0]?.id ?? null
}

export async function createSession(
  userId: number,
  dayNumber: number,
  dayTitle: string,
  startTime: string | Date | null = null,
  isDemo = false,
  split: string | null = null,
): Promise<number> {
  const ts = formatDateForMySQL(startTime ? startTime : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO workouts (user_id, program_day_id, day_number, day_title, split, start_time, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      await findProgramDayId(userId, dayNumber),
      dayNumber,
      dayTitle,
      split,
      ts,
      isDemo ? 1 : 0,
    ],
  )
  return result.insertId
}

export async function recordSetTiming(
  sessionId: number,
  userId: number,
  exerciseName: string,
  setIndex: number,
  startTime: string,
  endTime: string,
  weight: number,
  reps: number,
  note: string | null = null,
  isWarmup = false,
  primaryMuscles: string[] = [],
  secondaryMuscles: string[] = [],
  machineName: string | null = null,
  rir: number | null = null,
  { openWorkoutOnly = false }: { openWorkoutOnly?: boolean } = {},
): Promise<RecordSetResult> {
  const start = new Date(startTime)
  const end = new Date(endTime)
  const setDuration = Math.round((end.getTime() - start.getTime()) / 1000)

  try {
    return await withTransaction(async (connection) => {
      // The counter bump is also the ownership check, so there is no separate
      // SELECT before this and no window between checking and inserting. It runs
      // first for that reason: the workout_sets FK only proves the workout
      // exists, not that the caller owns it. completed_sets always changes, so
      // affectedRows === 0 means no such workout for this user, full stop.
      //
      // An ended workout still takes the set. sessionCleanup ends a workout
      // after 30 minutes the server can't see, which is exactly when a phone
      // with no signal is still logging offline, and the app drops a queued set
      // the server refuses. A late set moves end_time forward to its own end so
      // no set sits after its workout's end. Assignments run left to right, so
      // total_duration sees the new end_time.
      const [owned] = await connection.execute<ResultSetHeader>(
        `UPDATE workouts SET completed_sets = completed_sets + 1,
           end_time = IF(end_time IS NULL, NULL, GREATEST(end_time, ?)),
           total_duration = IF(end_time IS NULL, total_duration,
                               TIMESTAMPDIFF(SECOND, start_time, end_time))
         WHERE id = ? AND user_id = ?${openWorkoutOnly ? " AND end_time IS NULL" : ""}`,
        [formatDateForMySQL(endTime), sessionId, userId],
      )
      // Thrown, not rolled back here. The catch below handles the rollback.
      if (owned.affectedRows === 0) {
        // A trainer may only log into the workout in progress. Which of the two
        // it was decides whether the client should reconcile (409, the workout
        // is closed) or stop retrying (403, not theirs).
        if (openWorkoutOnly) {
          const [exists] = await connection.execute<RowDataPacket[]>(
            `SELECT id FROM workouts WHERE id = ? AND user_id = ?`,
            [sessionId, userId],
          )
          if (exists.length)
            throw new ConflictError(
              "Session has already ended",
              "SESSION_ALREADY_ENDED",
            )
        }
        throw new ForbiddenError("Session not found or unauthorized", "SESSION_NOT_FOUND")
      }

      // Only now, with ownership proved, may the shared catalog be written, and
      // on this connection, so a rolled-back set leaves no catalog row behind.
      const exerciseId = await findOrCreateExercise(
        userId,
        exerciseName,
        primaryMuscles,
        secondaryMuscles,
        connection,
      )

      const [lastSets] = await connection.execute<RowDataPacket[]>(
        // created_at has 1s resolution, and id breaks ties so "previous set" is
        // deterministic for sets logged in the same second.
        `SELECT end_time FROM workout_sets WHERE workout_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        [sessionId],
      )
      // Floored at 0: two devices whose clocks disagree produced a negative
      // rest, which reads as a set logged before the one it followed.
      const restTime: number | null =
        lastSets.length > 0
          ? Math.max(
              0,
              Math.round(
                (start.getTime() -
                  parseMySQLDate(lastSets[0].end_time).getTime()) /
                  1000,
              ),
            )
          : null

      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO workout_sets (workout_id, exercise_id, set_index, start_time, end_time, set_duration, rest_time, weight, reps, note, is_warmup, rir, machine_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          exerciseId,
          setIndex,
          formatDateForMySQL(startTime),
          formatDateForMySQL(endTime),
          setDuration,
          restTime,
          weight,
          reps,
          note,
          isWarmup ? 1 : 0,
          rir,
          machineName,
        ],
      )

      return {
        id: result.insertId,
        exerciseId,
        setDuration,
        restTime,
        rir,
        machineName,
      }
    })
  } catch (err) {
    // ck_ws_times: an end before the start is a bad request, not a 500.
    throw throwCheckViolation(err, "Set end time cannot be before start time")
  }
}

/**
 * Re-derive rest_time for every set of one workout: the gap from the previous
 * set's end (in logging order, created_at then id, the order recordSetTiming
 * uses) to this set's start, floored at 0, NULL for the first set.
 * recordSetTiming computes it once on insert. Without this an edited time or
 * a deleted set left the neighbouring set's rest stale permanently. One statement
 * over one workout's sets (idx_ws_workout_*).
 */
async function recomputeRestTimes(conn: Queryable, workoutId: number): Promise<void> {
  await conn.execute(
    `UPDATE workout_sets ws
       JOIN (SELECT id, LAG(end_time) OVER (ORDER BY created_at, id) AS prev_end
             FROM workout_sets WHERE workout_id = ?) p ON p.id = ws.id
        SET ws.rest_time = IF(p.prev_end IS NULL, NULL,
                              GREATEST(0, TIMESTAMPDIFF(SECOND, p.prev_end, ws.start_time)))
      WHERE ws.workout_id = ?`,
    [workoutId, workoutId],
  )
}

interface UpdateSetTimingParams {
  exerciseName?: string
  primaryMuscles?: string[]
  secondaryMuscles?: string[]
  weight?: number
  reps?: number
  startTime?: string
  endTime?: string
  note?: string | null
  isWarmup?: boolean
  rir?: number | null
  machineName?: string | null
}

/**
 * Update one recorded set. Verifies the set belongs to a workout owned by
 * the caller, applies only the provided fields, and recomputes set_duration if
 * either timestamp changes. Returns the updated row joined with its exercise.
 */
export async function updateSetTiming(
  sessionId: number,
  setId: number,
  userId: number,
  updates: UpdateSetTimingParams,
  { openWorkoutOnly = false }: { openWorkoutOnly?: boolean } = {},
): Promise<SetTiming> {
  const [owned] = await pool.execute<WorkoutSetRow[]>(
    `SELECT ws.start_time AS startTime, ws.end_time AS endTime,
            w.end_time IS NOT NULL AS workoutEnded
     FROM workout_sets ws
     JOIN workouts w ON ws.workout_id = w.id
     WHERE ws.id = ? AND ws.workout_id = ? AND w.user_id = ?`,
    [setId, sessionId, userId],
  )
  if (!owned[0]) throw new NotFoundError("Set")
  // Trainer mode: only the workout in progress. A check-then-write race with
  // the workout ending in between is harmless: the edit is applied a moment late
  // on a set that was editable when asked.
  if (openWorkoutOnly && owned[0].workoutEnded)
    throw new ForbiddenError(
      "Trainers can only edit sets of a workout in progress",
      "TRAINER_WORKOUT_ENDED",
    )

  const assignments: string[] = []
  const params: (string | number | null)[] = []
  const set = (col: string, value: string | number | null) => {
    assignments.push(`${col} = ?`)
    params.push(value)
  }

  const u = updates
  if (u.exerciseName !== undefined)
    set(
      "exercise_id",
      await findOrCreateExercise(
        userId,
        u.exerciseName,
        u.primaryMuscles ?? [],
        u.secondaryMuscles ?? [],
      ),
    )
  if (u.weight !== undefined) set("weight", u.weight)
  if (u.reps !== undefined) set("reps", u.reps)
  if (u.note !== undefined) set("note", u.note)
  if (u.isWarmup !== undefined) set("is_warmup", u.isWarmup ? 1 : 0)
  if (u.rir !== undefined) set("rir", u.rir)
  if (u.machineName !== undefined) set("machine_name", u.machineName)
  if (u.startTime !== undefined)
    set("start_time", formatDateForMySQL(u.startTime))
  if (u.endTime !== undefined) set("end_time", formatDateForMySQL(u.endTime))
  if (u.startTime !== undefined || u.endTime !== undefined) {
    const start = parseMySQLDate(u.startTime ?? (owned[0].startTime as string))
    const end = parseMySQLDate(u.endTime ?? (owned[0].endTime as string))
    set("set_duration", Math.round((end.getTime() - start.getTime()) / 1000))
  }

  if (assignments.length > 0) {
    params.push(setId)
    const timesChanged = u.startTime !== undefined || u.endTime !== undefined
    try {
      await withTransaction(async (conn) => {
        await conn.execute(
          `UPDATE workout_sets SET ${assignments.join(", ")} WHERE id = ?`,
          params,
        )
        // This set's start moves its own rest, and its end moves the next set's.
        if (timesChanged) await recomputeRestTimes(conn, sessionId)
      })
    } catch (err) {
      // ck_ws_times: an end before the start is a bad request, not a 500.
      throw throwCheckViolation(err, "Set end time cannot be before start time")
    }
  }

  const [updated] = await pool.execute<WorkoutSetRow[]>(
    `SELECT ${SET_COLS}
     ${SET_FROM}
     JOIN workouts w ON ws.workout_id = w.id
     WHERE ws.id = ? AND w.user_id = ?`,
    [setId, userId],
  )
  return updated[0]!
}

/**
 * Delete one recorded set, addressed the way the client knows it: by exercise
 * name and set index rather than by row id, because the app undoes a set it
 * has only ever identified by its position in the day.
 *
 * A set the client already removed locally is not an error: deleting nothing
 * returns deletedCount 0 so a retry after a failed sync is idempotent. Only a
 * missing or foreign workout is a 404.
 */
export async function deleteSetByIndex(
  sessionId: number,
  userId: number,
  exerciseName: string,
  setIndex: number,
): Promise<number> {
  const [owned] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM workouts WHERE id = ? AND user_id = ?`,
    [sessionId, userId],
  )
  if (!owned.length) throw new NotFoundError("Session")

  return withTransaction(async (connection) => {
    // Same (exercise, index) can legitimately appear twice: a set re-logged
    // after a failed sync. The most recent row is the one the user just saw.
    const [matches] = await connection.execute<RowDataPacket[]>(
      `SELECT ws.id FROM workout_sets ws JOIN exercises e ON ws.exercise_id = e.id
       WHERE ws.workout_id = ? AND e.name = ? AND ws.set_index = ?
       ORDER BY ws.id DESC LIMIT 1`,
      [sessionId, exerciseName, setIndex],
    )
    if (!matches.length) return 0

    await connection.execute(`DELETE FROM workout_sets WHERE id = ?`, [
      matches[0].id,
    ])
    // The set after it rested since the one before it now.
    await recomputeRestTimes(connection, sessionId)
    // completed_sets is the stored count getSessionHistory reports instead of
    // counting rows, so it has to come down with the row. GREATEST floors it
    // at 0 rather than trusting a counter that predates this delete path.
    await connection.execute(
      `UPDATE workouts SET completed_sets = GREATEST(completed_sets - 1, 0) WHERE id = ?`,
      [sessionId],
    )

    return 1
  })
}

/**
 * Rename (and/or re-group) an exercise everywhere it appears in a split's
 * workout history. Because the exercises table is shared globally (unique by
 * name), we re-point the matching workout_sets rows at the target exercise
 * rather than mutating the shared exercise row, which would rewrite every
 * other user's history too. Returns the number of set rows updated.
 */
export async function renameExerciseInHistory(
  userId: number,
  split: string,
  oldName: string,
  newName?: string,
  primaryMuscles?: string[],
  secondaryMuscles?: string[],
): Promise<number> {
  const targetName = newName?.trim() || oldName
  // Nothing of the caller's to rename means nothing to write, in particular
  // no new row in the shared catalog for a name nobody logged.
  const [matches] = await pool.execute<RowDataPacket[]>(
    `SELECT 1 FROM workout_sets ws
     JOIN workouts w ON ws.workout_id = w.id
     JOIN exercises e ON ws.exercise_id = e.id
     WHERE w.user_id = ? AND w.split = ? AND e.name = ? LIMIT 1`,
    [userId, split, oldName],
  )
  if (!matches.length) return 0
  const targetExerciseId = await findOrCreateExercise(
    userId,
    targetName,
    primaryMuscles ?? [],
    secondaryMuscles ?? [],
  )
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE workout_sets ws
     JOIN workouts w ON ws.workout_id = w.id
     JOIN exercises e ON ws.exercise_id = e.id
     SET ws.exercise_id = ?
     WHERE w.user_id = ? AND w.split = ? AND e.name = ?`,
    [targetExerciseId, userId, split, oldName],
  )
  return result.affectedRows
}

/**
 * Close a workout. Idempotent: the `end_time IS NULL` guard makes a retried or
 * double-tapped end a no-op that returns the row as it already stands, rather
 * than rewriting end_time: an end call replayed after a week offline used to
 * turn a 45-minute workout into a 7-day one. `alreadyEnded` tells the client
 * which of the two happened, so it can reconcile instead of retrying.
 */
export async function endSession(
  sessionId: number,
  userId: number,
  endTime: string | Date | null = null,
): Promise<{ session: Session; alreadyEnded: boolean }> {
  const ts = formatDateForMySQL(endTime ?? new Date())
  // Scoped by user_id like every other statement in this file, rather than
  // trusting the route to have checked first.
  let updated: ResultSetHeader
  try {
    const [res] = await pool.execute<ResultSetHeader>(
      `UPDATE workouts SET end_time = ?, total_duration = TIMESTAMPDIFF(SECOND, start_time, ?)
       WHERE id = ? AND user_id = ? AND end_time IS NULL`,
      [ts, ts, sessionId, userId],
    )
    updated = res
  } catch (err) {
    // ck_w_times: an end before the workout's start is a bad request, not a
    // 500. The two set paths already treat it that way.
    throw throwCheckViolation(
      err,
      "Session end time cannot be before its start time",
    )
  }
  const [rows] = await pool.execute<WorkoutRow[]>(
    `SELECT ${WORKOUT_COLS} ${WORKOUT_FROM} WHERE w.id = ? AND w.user_id = ?`,
    [sessionId, userId],
  )
  const row = rows[0]
  // The UPDATE reports 0 rows for an unchanged value as well as for a missing
  // one, so ownership is decided by the read, not by affectedRows.
  if (!row) throw new ForbiddenError("Session not found or unauthorized", "SESSION_NOT_FOUND")
  return {
    session: {
      ...row,
      primaryMuscles: parseMuscleGroups(row.primaryMuscles),
      secondaryMuscles: parseMuscleGroups(row.secondaryMuscles),
    } as unknown as Session,
    alreadyEnded: updated.affectedRows === 0,
  }
}

export async function updateSessionDay(
  sessionId: number,
  userId: number,
  dayNumber: number,
  dayTitle: string | null,
): Promise<Session> {
  await pool.execute<ResultSetHeader>(
    `UPDATE workouts SET day_number = ?, day_title = ?, program_day_id = ?
     WHERE id = ? AND user_id = ?`,
    [dayNumber, dayTitle, await findProgramDayId(userId, dayNumber), sessionId, userId],
  )
  return getSessionDetails(sessionId, userId)
}

export async function getSessionDetails(
  sessionId: number,
  userId: number,
): Promise<Session> {
  const [workouts] = await pool.execute<WorkoutRow[]>(
    `SELECT ${WORKOUT_COLS}, u.name AS userName ${WORKOUT_FROM}
     JOIN users u ON w.user_id = u.id WHERE w.id = ? AND w.user_id = ?`,
    [sessionId, userId],
  )
  if (!workouts[0])
    throw new ForbiddenError("Session not found or unauthorized", "SESSION_NOT_FOUND")

  const [sets] = await pool.execute<WorkoutSetRow[]>(
    `SELECT ${SET_COLS}
     ${SET_FROM}
     -- Insertion order IS the order the sets were performed, and it is the only
     -- record of it since exercise_index was dropped. Sorting by exercise name
     -- listed a workout alphabetically; sorting by set_index interleaved the
     -- exercises. idx_ws_workout_created covers this exactly.
     WHERE ws.workout_id = ? ORDER BY ws.created_at ASC, ws.id ASC`,
    [sessionId],
  )
  return {
    ...workouts[0],
    primaryMuscles: parseMuscleGroups(workouts[0].primaryMuscles),
    secondaryMuscles: parseMuscleGroups(workouts[0].secondaryMuscles),
    setTimings: sets,
  } as unknown as Session
}

/** Position in the history order: page after this (startTime, id). */
export interface HistoryCursor {
  /** "YYYY-MM-DD HH:MM:SS", UTC: the startTime format responses use. */
  startTime: string
  id: number
}

/** The opaque `before` value for the page after `session`. */
export const historyCursor = (session: { startTime: string; id: number }) =>
  `${session.startTime},${session.id}`

/** Parse a `before` value, or null when it isn't one historyCursor produced. */
export function parseHistoryCursor(raw: string): HistoryCursor | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}),(\d{1,10})$/.exec(raw.trim())
  if (!m) return null
  const id = Number(m[3])
  if (!Number.isSafeInteger(id) || id < 1) return null
  return { startTime: `${m[1]} ${m[2]}`, id }
}

export async function getSessionHistory(
  userId: number,
  split?: string | null,
  dayNumber?: number | null,
  limit = 30,
  includeTimings = false,
  before: HistoryCursor | null = null,
): Promise<Session[]> {
  // setCount was a correlated (SELECT COUNT(*) FROM workout_sets ...): one
  // index scan per returned row, up to 365 of them on one request.
  // workouts.completed_sets is maintained inside the same transaction as the
  // set itself (incremented by recordSetTiming, decremented by
  // deleteSetByIndex), so the column already has exactly this number.
  let q = `SELECT ${WORKOUT_COLS}, u.name AS userName, u.username,
      w.completed_sets AS setCount
     ${WORKOUT_FROM} JOIN users u ON w.user_id = u.id
     WHERE w.user_id = ?`
  const params: (string | number)[] = [userId]
  if (split) {
    q += ` AND w.split = ?`
    params.push(split)
  }
  if (dayNumber != null) {
    q += ` AND w.day_number = ?`
    params.push(dayNumber)
  }
  // Keyset, not OFFSET: the next page starts strictly after the last row of
  // this one, on the same (start_time, id) order, so it stays an index range
  // scan however deep the caller pages. id breaks start_time ties.
  if (before) {
    q += ` AND (w.start_time < ? OR (w.start_time = ? AND w.id < ?))`
    params.push(before.startTime, before.startTime, before.id)
  }
  q += ` ORDER BY w.start_time DESC, w.id DESC LIMIT ?`
  params.push(limit)

  const [rows] = await pool.execute<WorkoutRow[]>(q, params)
  if (!rows.length) return []

  const sessions: Session[] = rows.map((r) => ({
    ...(r as unknown as Session),
    primaryMuscles: parseMuscleGroups(r.primaryMuscles),
    secondaryMuscles: parseMuscleGroups(r.secondaryMuscles),
    setTimings: [],
  }))

  if (includeTimings) {
    const ids = sessions.map((s) => s.id)
    // ids come entirely from our own DB query above, so safe to interpolate
    // placeholders. Never use this pattern with user-supplied values.
    const [sets] = await pool.execute<WorkoutSetRow[]>(
      `SELECT ${SET_COLS}
       ${SET_FROM}
       WHERE ws.workout_id IN (${ids.map(() => "?").join(",")})
       ORDER BY ws.workout_id ASC, ws.created_at ASC, ws.id ASC`,
      ids,
    )
    const bySession: Record<number, SetTiming[]> = {}
    for (const t of sets) {
      if (!bySession[t.sessionId]) bySession[t.sessionId] = []
      bySession[t.sessionId].push(t)
    }
    sessions.forEach((s) => {
      s.setTimings = bySession[s.id] || []
    })
  }
  return sessions
}

/** The fields pickRecordSetIds reads, one row per candidate set. */
export interface RecordCandidate {
  id: number
  exerciseName: string
  machineName: string | null
  weight: number
  reps: number
  /** getRecordSessions filters warm-ups in SQL, and they are filtered here too. */
  isWarmup?: boolean | number
}

const RECORD_REP_COUNTS = 12

/** Ids bound per `IN (…)`, well under MySQL's 65,535-placeholder ceiling. */
const IN_CHUNK = 5000

function* chunksOf<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

/** Epley one-rep-max estimate. A one-rep set is its own estimate. */
const epley = (weight: number, reps: number): number =>
  reps === 1 ? weight : weight * (1 + reps / 30)

/**
 * The ids of the sets that have an all-time record, per (exercise, machine):
 * a null machine is its own group. Mirrors the app's offline
 * `pickRecordSessions` (src/utils/recordSets.ts). Change the two together.
 *
 * Per group it keeps the heaviest and the lightest set (assisted lifts count
 * less assistance as more load), the most reps, the best Epley estimate, and
 * the heaviest and lightest set at each rep count 1 to 12. `candidates` must be in
 * chronological order: only a strictly better set replaces a kept one, so a
 * tie keeps the earliest.
 */
export function pickRecordSetIds(candidates: RecordCandidate[]): Set<number> {
  type Best = { id: number; value: number }
  const groups = new Map<string, Map<string, Best>>()

  const consider = (
    best: Map<string, Best>,
    slot: string,
    id: number,
    value: number,
    higherWins: boolean,
  ) => {
    const cur = best.get(slot)
    if (!cur || (higherWins ? value > cur.value : value < cur.value))
      best.set(slot, { id, value })
  }

  for (const c of candidates) {
    if (c.isWarmup || !(c.reps >= 1) || !Number.isFinite(c.weight)) continue
    // JSON-encoded so no exercise or machine name can collide with another
    // pair, and null remains distinct from the string "null".
    const key = JSON.stringify([c.exerciseName, c.machineName ?? null])
    let best = groups.get(key)
    if (!best) groups.set(key, (best = new Map()))

    consider(best, "maxWeight", c.id, c.weight, true)
    consider(best, "minWeight", c.id, c.weight, false)
    consider(best, "maxReps", c.id, c.reps, true)
    consider(best, "epley", c.id, epley(c.weight, c.reps), true)
    if (c.reps <= RECORD_REP_COUNTS) {
      consider(best, `max@${c.reps}`, c.id, c.weight, true)
      consider(best, `min@${c.reps}`, c.id, c.weight, false)
    }
  }

  const ids = new Set<number>()
  for (const best of groups.values())
    for (const { id } of best.values()) ids.add(id)
  return ids
}

/**
 * Every session owning at least one all-time record set, with `setTimings`
 * trimmed to just those sets, the same shape as getSessionHistory with timings.
 * The app only loads its latest 50 to 100 sessions, so without this a record
 * older than that window was forgotten.
 *
 * Three queries whatever the history size: the candidate sets (only the five
 * columns the selection reads), then the parent sessions and the kept sets.
 * Demo workouts are left out, as analytics and friend views leave them out: a
 * record set in the sample data isn't something the user lifted.
 */
export async function getRecordSessions(userId: number): Promise<Session[]> {
  const [candidates] = await pool.execute<
    (RowDataPacket & RecordCandidate & { sessionId: number })[]
  >(
    `SELECT ws.id, ws.workout_id AS sessionId, e.name AS exerciseName,
            ws.machine_name AS machineName, ws.weight, ws.reps
     FROM workout_sets ws
     JOIN workouts w ON w.id = ws.workout_id
     JOIN exercises e ON e.id = ws.exercise_id
     WHERE w.user_id = ? AND w.is_demo = 0 AND ws.is_warmup = 0 AND ws.reps >= 1
       AND ws.weight IS NOT NULL
     ORDER BY ws.start_time ASC, ws.id ASC`,
    [userId],
  )
  const keptIds = pickRecordSetIds(candidates)
  if (keptIds.size === 0) return []

  // Kept set ids grouped by their session, in first-seen order.
  const keptBySession = new Map<number, number[]>()
  for (const c of candidates) {
    if (!keptIds.has(c.id)) continue
    const list = keptBySession.get(c.sessionId)
    if (list) list.push(c.id)
    else keptBySession.set(c.sessionId, [c.id])
  }
  const sessionIds = [...keptBySession.keys()]

  // Both id lists come from the query above, never from the request. They are
  // bound in chunks: a long history can keep tens of thousands of record sets,
  // and one `IN (?, …)` past 65,535 placeholders fails outright.
  const rows: WorkoutRow[] = []
  for (const chunk of chunksOf(sessionIds, IN_CHUNK)) {
    const [part] = await pool.execute<WorkoutRow[]>(
      `SELECT ${WORKOUT_COLS}, u.name AS userName, u.username,
          w.completed_sets AS setCount
       ${WORKOUT_FROM} JOIN users u ON w.user_id = u.id
       WHERE w.user_id = ? AND w.id IN (${chunk.map(() => "?").join(",")})`,
      [userId, ...chunk],
    )
    rows.push(...part)
  }
  // Newest first, as the one query ordered them (start_time strings sort
  // chronologically, and id breaks ties the same way the history list does).
  rows.sort((a, b) =>
    a.startTime === b.startTime
      ? b.id - a.id
      : String(a.startTime) < String(b.startTime) ? 1 : -1,
  )

  // Set chunks break only between sessions, so each session's sets arrive in
  // one query, in performed order.
  const sets: WorkoutSetRow[] = []
  let chunk: number[] = []
  const flush = async () => {
    if (!chunk.length) return
    const [part] = await pool.execute<WorkoutSetRow[]>(
      `SELECT ${SET_COLS}
       ${SET_FROM}
       WHERE ws.id IN (${chunk.map(() => "?").join(",")})
       ORDER BY ws.workout_id ASC, ws.created_at ASC, ws.id ASC`,
      chunk,
    )
    sets.push(...part)
    chunk = []
  }
  for (const ids of keptBySession.values()) {
    if (chunk.length && chunk.length + ids.length > IN_CHUNK) await flush()
    chunk.push(...ids)
  }
  await flush()

  const bySession = new Map<number, SetTiming[]>()
  for (const t of sets) {
    const list = bySession.get(t.sessionId)
    if (list) list.push(t)
    else bySession.set(t.sessionId, [t])
  }
  return rows.map((r) => ({
    ...(r as unknown as Session),
    primaryMuscles: parseMuscleGroups(r.primaryMuscles),
    secondaryMuscles: parseMuscleGroups(r.secondaryMuscles),
    setTimings: bySession.get(r.id) ?? [],
  }))
}

export async function deleteAllSessionsForSplit(
  userId: number,
  split: string,
): Promise<number> {
  // workout_sets rows are covered by ON DELETE CASCADE on fk_ws_workout, so
  // deleting the parent workouts rows is the whole job: one statement, no
  // transaction needed.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM workouts WHERE user_id = ? AND split = ?`,
    [userId, split],
  )
  return result.affectedRows
}

// A workout is only ever closed by the client calling POST /:sessionId/end.
// If the app is killed, crashes, or the device dies mid-workout, that call
// never happens and the workout (and the day it belongs to) remains open in
// the DB forever. No server-side backstop existed for this. This function
// backs a periodic job (see jobs/sessionCleanup.ts) that ends workouts nobody
// is actively touching anymore, using the same 30-minute inactivity threshold
// the client already applies locally (see WorkoutContext's
// checkAndEndStaleSession).

/**
 * End every open workout (end_time IS NULL) whose last activity (the end_time
 * of its most recently recorded set, or its start_time if no set was ever
 * recorded) is older than `thresholdMinutes` ago.
 *
 * Workouts are ended AT their last activity, not at "now", so total_duration
 * reflects when the user actually stopped rather than whenever the cleanup job
 * happened to run.
 *
 * Returns the (id, userId) pairs it ended, so the caller can tell the owner's
 * device: without an event the app's first sign is a 404 on the next set, which
 * silently drops the set the user just did.
 */
/** Workouts ended per transaction. The sweep loops until a batch comes up short. */
const STALE_BATCH = 500
/** Upper bound on batches per sweep, so one tick can't run unbounded. */
const STALE_MAX_BATCHES = 20

/**
 * Last activity of workout `w`: its latest set's end, or its start. Correlated,
 * not a derived table: grouping all of workout_sets by workout_id
 * materialised the entire table every run to find the handful of open
 * workouts. GREATEST(w.start_time, ...): nothing stops a client sending a set
 * whose end_time predates its workout's start (a slow clock, an offline set
 * replayed later), and ending a workout before its start violates ck_w_times.
 */
const LAST_ACTIVITY = `GREATEST(
  w.start_time,
  COALESCE(
    (SELECT MAX(ws.end_time) FROM workout_sets ws WHERE ws.workout_id = w.id),
    w.start_time
  )
)`

export async function endStaleSessions(
  thresholdMinutes: number,
): Promise<{ id: number; userId: string }[]> {
  const connection: PoolConnection = await pool.getConnection()
  try {
    // One sweep at a time across everything sharing this database: two
    // processes booting side by side, or a slow tick overlapping the next.
    // Timeout 0: if another sweep holds it, that one is doing the work.
    const [[lock]] = await connection.query<RowDataPacket[]>(
      `SELECT GET_LOCK('owngains_session_cleanup', 0) AS got`,
    )
    if (lock?.got !== 1) return []
    try {
      const ended: { id: number; userId: string }[] = []
      for (let i = 0; i < STALE_MAX_BATCHES; i++) {
        const batch = await endStaleBatch(connection, thresholdMinutes)
        ended.push(...batch.ended)
        if (batch.candidates < STALE_BATCH) break
      }
      return ended
    } finally {
      await connection.query(`SELECT RELEASE_LOCK('owngains_session_cleanup')`)
    }
  } finally {
    connection.release()
  }
}

/**
 * One batch of the sweep, as a transaction: lock up to STALE_BATCH stale open
 * workouts, end exactly those, and report exactly those. The SELECT and UPDATE
 * used to be separate statements, so an event could name a workout that wasn't
 * ended, or a workout be ended with no event.
 */
async function endStaleBatch(
  connection: PoolConnection,
  thresholdMinutes: number,
): Promise<{ candidates: number; ended: { id: number; userId: string }[] }> {
  // READ COMMITTED for this transaction only: under the default REPEATABLE
  // READ the locking scan took next-key (gap) locks across the open-workout
  // range, blocking other users' starts and ends while it ran. Record locks on
  // the rows it returns are all it needs.
  await connection.query(`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`)
  await connection.beginTransaction()
  try {
    // `w.start_time < threshold` is implied by the activity test (activity is
    // never earlier than the start) and is what lets idx_w_open (end_time,
    // start_time) narrow the scan to old open workouts. FOR UPDATE locks just
    // those rows, while the subquery's workout_sets reads are plain reads. A set
    // being recorded right now holds its workout's row lock (recordSetTiming
    // bumps completed_sets first), so this waits for it, sees its end_time,
    // and no longer finds the workout stale.
    const [stale] = await connection.execute<RowDataPacket[]>(
      `SELECT w.id, w.user_id AS ownerId
       FROM workouts w
       WHERE w.end_time IS NULL
         AND w.start_time < (NOW() - INTERVAL ? MINUTE)
         AND ${LAST_ACTIVITY} < (NOW() - INTERVAL ? MINUTE)
       LIMIT ${STALE_BATCH}
       FOR UPDATE`,
      [thresholdMinutes, thresholdMinutes],
    )
    if (stale.length === 0) {
      await connection.commit()
      return { candidates: 0, ended: [] }
    }
    const ids = stale.map((r) => r.id as number)
    const marks = ids.map(() => "?").join(",")

    // total_duration reads w.end_time set on the line above it: MySQL and
    // MariaDB evaluate single-table UPDATE assignments left to right.
    // `end_time IS NULL` again: the rows are locked, so it always holds. It is
    // there so this statement can never rewrite a closed workout.
    await connection.execute<ResultSetHeader>(
      `UPDATE workouts w
       SET w.end_time = ${LAST_ACTIVITY},
           w.total_duration = TIMESTAMPDIFF(SECOND, w.start_time, w.end_time)
       WHERE w.id IN (${marks}) AND w.end_time IS NULL`,
      ids,
    )
    // Report exactly what this transaction closed, with the owner's public id.
    const [closed] = await connection.execute<RowDataPacket[]>(
      `SELECT w.id, u.uuid AS userId
       FROM workouts w JOIN users u ON u.id = w.user_id
       WHERE w.id IN (${marks}) AND w.end_time IS NOT NULL`,
      ids,
    )
    await connection.commit()
    return {
      candidates: stale.length,
      ended: closed.map((r) => ({ id: r.id as number, userId: r.userId as string })),
    }
  } catch (err) {
    await connection.rollback()
    throw err
  }
}
