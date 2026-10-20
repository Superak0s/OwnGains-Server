import { pool, formatDateForMySQL, parseMySQLDate } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { NotFoundError } from "@/middleware/errorHandler.js"

/** A planned workout as the API returns it. */
export interface ScheduledWorkout {
  id: number
  title: string
  programDay: number | null
  startAt: string
  durationMin: number
  reminderMinutes: number | null
  alarm: boolean
  status: "pending" | "accepted" | "cancelled"
  scheduledBy: { uuid: string; username: string } | null
}

/** The writable fields, already validated. */
export interface ScheduleFields {
  title: string
  programDay: number | null
  startAt: Date
  durationMin: number
  reminderMinutes: number | null
  alarm: boolean
}

interface Row extends RowDataPacket {
  id: number
  title: string
  program_day: number | null
  start_at: string
  duration_min: number
  reminder_minutes: number | null
  alarm: number
  created_by_trainer_id: number | null
  accepted_at: string | null
  cancelled_at: string | null
  trainer_uuid: string | null
  trainer_username: string | null
}

const SELECT = `SELECT s.*, t.uuid AS trainer_uuid, t.username AS trainer_username
  FROM scheduled_workouts s LEFT JOIN users t ON t.id = s.created_by_trainer_id`

const toEntry = (r: Row): ScheduledWorkout => ({
  id: r.id,
  title: r.title,
  programDay: r.program_day,
  startAt: parseMySQLDate(r.start_at).toISOString(),
  durationMin: r.duration_min,
  reminderMinutes: r.reminder_minutes,
  alarm: r.alarm === 1,
  status: r.cancelled_at != null ? "cancelled" : r.accepted_at == null ? "pending" : "accepted",
  scheduledBy:
    r.trainer_uuid && r.trainer_username ? { uuid: r.trainer_uuid, username: r.trainer_username } : null,
})

/** A user's entries starting in [from, to), earliest first, cancelled ones only when asked for. */
export async function listScheduled(
  userId: number,
  from: Date,
  to: Date,
  includeCancelled = false,
): Promise<ScheduledWorkout[]> {
  const [rows] = await pool.query<Row[]>(
    `${SELECT} WHERE s.user_id = ? ${includeCancelled ? "" : "AND s.cancelled_at IS NULL"} AND s.start_at >= ? AND s.start_at < ?
     ORDER BY s.start_at, s.id`,
    [userId, formatDateForMySQL(from), formatDateForMySQL(to)],
  )
  return rows.map(toEntry)
}

/** One entry of a user, cancelled or not, with who suggested it. */
export async function getScheduled(
  userId: number,
  id: number,
): Promise<ScheduledWorkout & { trainerId: number | null; cancelled: boolean }> {
  const [rows] = await pool.query<Row[]>(`${SELECT} WHERE s.user_id = ? AND s.id = ?`, [userId, id])
  if (!rows[0]) throw new NotFoundError("Scheduled workout")
  return { ...toEntry(rows[0]), trainerId: rows[0].created_by_trainer_id, cancelled: rows[0].cancelled_at != null }
}

/** Adds an entry. One from a trainer starts as a pending suggestion. */
export async function createScheduled(
  userId: number,
  fields: ScheduleFields,
  trainerId: number | null,
): Promise<ScheduledWorkout> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO scheduled_workouts
       (user_id, title, program_day, start_at, duration_min, reminder_minutes, alarm, created_by_trainer_id, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${trainerId == null ? "UTC_TIMESTAMP()" : "NULL"})`,
    [
      userId,
      fields.title,
      fields.programDay,
      formatDateForMySQL(fields.startAt),
      fields.durationMin,
      fields.reminderMinutes,
      fields.alarm,
      trainerId,
    ],
  )
  const { trainerId: _t, cancelled: _c, ...entry } = await getScheduled(userId, result.insertId)
  return entry
}

/**
 * Writes the given fields. `pending` true puts a suggestion back up for acceptance,
 * false accepts it. `cancel` withdraws or declines it.
 */
export async function updateScheduled(
  userId: number,
  id: number,
  fields: Partial<ScheduleFields>,
  { pending, cancel }: { pending?: boolean; cancel?: boolean },
): Promise<void> {
  const sets: string[] = []
  const values: unknown[] = []
  const columns: Record<keyof ScheduleFields, string> = {
    title: "title",
    programDay: "program_day",
    startAt: "start_at",
    durationMin: "duration_min",
    reminderMinutes: "reminder_minutes",
    alarm: "alarm",
  }
  for (const [key, column] of Object.entries(columns) as [keyof ScheduleFields, string][]) {
    if (fields[key] === undefined) continue
    sets.push(`${column} = ?`)
    values.push(key === "startAt" ? formatDateForMySQL(fields.startAt!) : fields[key])
  }
  if (pending === true) sets.push("accepted_at = NULL")
  if (pending === false) sets.push("accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP())")
  if (cancel) sets.push("cancelled_at = UTC_TIMESTAMP()")
  if (sets.length === 0) return
  await pool.query(`UPDATE scheduled_workouts SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`, [
    ...values,
    userId,
    id,
  ])
}

/** Removes an entry for good. */
export async function deleteScheduled(userId: number, id: number): Promise<void> {
  const [result] = await pool.query<ResultSetHeader>(
    "DELETE FROM scheduled_workouts WHERE user_id = ? AND id = ?",
    [userId, id],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Scheduled workout")
}
