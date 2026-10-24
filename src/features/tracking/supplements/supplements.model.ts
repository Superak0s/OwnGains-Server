// Supplements and the doses taken from them (`supplement_intake`).

import { pool, formatDateForMySQL, parseMySQLDate } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError } from "@/middleware/errorHandler.js"
import { DAY_MS, localDay } from "@/utils/timeZone.js"

/**
 * Per-user ceiling. Every summary read joins every supplement against a year of
 * intake, so the list has to remain bounded. Nobody takes a hundred.
 */
const MAX_SUPPLEMENTS_PER_USER = 100

/** "HH:MM" from the client → a MySQL TIME literal. */
const simpleTimeToMySQL = (t: string): string => {
  const [h = "00", m = "00"] = t.split(":")
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:00`
}

/** A supplement a user tracks, as returned to the client. */
export interface Supplement extends RowDataPacket {
  id: number
  name: string
  unit: string
  defaultAmount: number
  dosesPerDay: number
  doseIntervalMinutes: number | null
  reminderEnabled: boolean
  reminderTime: string | null
  color: string | null
  icon: string | null
  createdAt: string
  updatedAt: string
}

interface SupplementSummary extends Omit<Supplement, keyof RowDataPacket> {
  takenToday: boolean
  dosesToday: number
  lastTakenAt: string | null
  streak: number
}

interface SupplementEntry extends RowDataPacket {
  id: number
  supplementId: number
  amount: number
  takenAt: string
  note: string | null
  createdAt: string
}

// Aliased to camelCase in SQL, and the pool runs with decimalNumbers, so
// DECIMAL columns arrive as numbers, so no parseFloat(String(...)) round trip.
// TIME_FORMAT trims the seconds MySQL pads onto a TIME the client sent as HH:MM.
const SUPPLEMENT_COLS = `id, name, unit, default_amount AS defaultAmount,
       doses_per_day AS dosesPerDay, dose_interval_minutes AS doseIntervalMinutes,
       reminder_enabled AS reminderEnabled,
       TIME_FORMAT(reminder_time, '%H:%i') AS reminderTime, color, icon,
       created_at AS createdAt, updated_at AS updatedAt`

const INTAKE_COLS = `id, supplement_id AS supplementId, amount,
       taken_at AS takenAt, note, created_at AS createdAt`

/** The one column the driver won't hand back in its wire type. */
function withBooleans(row: Supplement): Supplement {
  row.reminderEnabled = !!row.reminderEnabled
  return row
}

/**
 * Creates a supplement.
 *
 * @param userId - Numeric id of the owner.
 * @param fields - Supplement settings. Only `name` is required.
 * @param fields.name - Display name.
 * @param fields.unit - Dose unit, such as `g` or `mg` (default `g`).
 * @param fields.defaultAmount - Amount pre-filled when logging a dose (default 5).
 * @param fields.dosesPerDay - How many doses make a full day (default 1).
 * @param fields.doseIntervalMinutes - Minimum minutes between doses, or null for no spacing (default null).
 * @param fields.reminderEnabled - Whether a reminder fires (default false).
 * @param fields.reminderTime - Reminder time as `HH:MM`, or null (default null).
 * @param fields.color - Display color, or null (default null).
 * @param fields.icon - Icon name, or null (default null).
 * @returns The new `supplements.id`.
 * @throws ValidationError `SUPPLEMENT_LIMIT` at 100 supplements.
 */
export async function createSupplement(
  userId: number,
  fields: {
    name: string
    unit?: string
    defaultAmount?: number
    reminderEnabled?: boolean
    reminderTime?: string | null
    color?: string | null
    icon?: string | null
    dosesPerDay?: number
    doseIntervalMinutes?: number | null
  },
): Promise<number> {
  const {
    name,
    unit = "g",
    defaultAmount = 5,
    reminderEnabled = false,
    reminderTime = null,
    color = null,
    icon = null,
    dosesPerDay = 1,
    doseIntervalMinutes = null,
  } = fields
  // Count-then-insert: two parallel creates can land one over the cap, which
  // is fine for a bound whose job is "not unbounded".
  const [[{ n }]] = await pool.execute<(RowDataPacket & { n: number })[]>(
    `SELECT COUNT(*) AS n FROM supplements WHERE user_id = ?`,
    [userId],
  )
  if (n >= MAX_SUPPLEMENTS_PER_USER)
    throw new ValidationError(
      `You can have at most ${MAX_SUPPLEMENTS_PER_USER} supplements`,
      null,
      "SUPPLEMENT_LIMIT",
    )

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO supplements
       (user_id, name, unit, default_amount, doses_per_day, dose_interval_minutes,
        reminder_enabled, reminder_time, color, icon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      name,
      unit,
      defaultAmount,
      dosesPerDay,
      doseIntervalMinutes,
      reminderEnabled ? 1 : 0,
      reminderTime ? simpleTimeToMySQL(reminderTime) : null,
      color,
      icon,
    ],
  )
  // The id only: the route answers with listSupplementSummaries, so reading
  // the bare row back here was a query nobody used.
  return result.insertId
}

/**
 * Loads one supplement.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id`.
 * @returns The supplement, or null when it is not the user's.
 */
export async function getSupplementById(
  userId: number,
  supplementId: number,
): Promise<Supplement | null> {
  const [rows] = await pool.execute<Supplement[]>(
    `SELECT ${SUPPLEMENT_COLS} FROM supplements WHERE id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return rows[0] ? withBooleans(rows[0]) : null
}

/**
 * Every supplement (or just `supplementId`) enriched with today's doses, last
 * dose and current streak. One query for the list, one for every logged day
 * and one for the last dose across all of them (grouped in JS): flat cost
 * regardless of how many supplements the user has.
 */
export async function listSupplementSummaries(
  userId: number,
  supplementId?: number,
  timeZone = "UTC",
): Promise<SupplementSummary[]> {
  const [supplements] = await pool.execute<Supplement[]>(
    `SELECT ${SUPPLEMENT_COLS} FROM supplements WHERE user_id = ?
     ${supplementId ? "AND id = ?" : ""} ORDER BY name ASC`,
    supplementId ? [userId, supplementId] : [userId],
  )
  if (supplements.length === 0) return []

  const [lastRows] = await pool.execute<
    (RowDataPacket & { supplementId: number; lastTakenAt: string })[]
  >(
    // "Now" comes from JS, the same UTC clock every other write uses. One
    // supplement's summary (after a create or edit) reads only its own rows.
    `SELECT supplement_id AS supplementId, MAX(taken_at) AS lastTakenAt
     FROM supplement_intake WHERE user_id = ? AND taken_at <= ?
       ${supplementId ? "AND supplement_id = ?" : ""}
     GROUP BY supplement_id`,
    supplementId
      ? [userId, formatDateForMySQL(new Date()), supplementId]
      : [userId, formatDateForMySQL(new Date())],
  )
  const lastBySupplement = new Map(
    lastRows.map((r) => [
      r.supplementId,
      parseMySQLDate(r.lastTakenAt).toISOString(),
    ]),
  )

  const rowsBySupplement = Map.groupBy(
    await recentIntake(userId, supplementId),
    (row) => row.supplementId,
  )
  const today = localDay(new Date(), timeZone)
  return supplements.map((s) => {
    const doses = dosesByDay(rowsBySupplement.get(s.id) ?? [], timeZone)
    const dosesToday = doses.get(today) ?? 0
    return {
      ...withBooleans(s),
      takenToday: dosesToday > 0,
      dosesToday,
      lastTakenAt: lastBySupplement.get(s.id) ?? null,
      streak: streakFromDays([...doses.keys()], today),
    }
  })
}

/**
 * Doses from the last 367 days. A streak breaks at the first missing day, so
 * older rows are dead weight. The day past a year covers zones ahead of UTC.
 */
async function recentIntake(userId: number, supplementId?: number) {
  const since = formatDateForMySQL(new Date(Date.now() - 367 * DAY_MS))
  const [rows] = await pool.execute<
    (RowDataPacket & { supplementId: number; takenAt: string })[]
  >(
    `SELECT supplement_id AS supplementId, taken_at AS takenAt
     FROM supplement_intake WHERE user_id = ? AND taken_at >= ?
       ${supplementId ? "AND supplement_id = ?" : ""}`,
    supplementId ? [userId, since, supplementId] : [userId, since],
  )
  return rows
}

/** Dose count per local day, newest day first. */
function dosesByDay(
  rows: { takenAt: string }[],
  timeZone: string,
): Map<string, number> {
  const days = rows
    .map((r) => localDay(parseMySQLDate(r.takenAt), timeZone))
    .sort()
    .reverse()
  const doses = new Map<string, number>()
  for (const day of days) doses.set(day, (doses.get(day) ?? 0) + 1)
  return doses
}

const previousDay = (day: string) =>
  new Date(Date.parse(day) - DAY_MS).toISOString().slice(0, 10)

/** Shared by getStreak and listSupplementSummaries. Days must be sorted DESC. */
function streakFromDays(days: string[], today: string): number {
  // A streak may run up to today or up to yesterday. Today being unlogged
  // doesn't break it yet.
  let cursor = days[0] === today ? today : previousDay(today)
  let streak = 0
  for (const day of days) {
    if (day !== cursor) break
    streak++
    cursor = previousDay(cursor)
  }
  return streak
}

/**
 * Updates the given settings of a supplement. Omitted fields stay unchanged.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id`.
 * @param fields - Same properties as in {@link createSupplement}, all optional.
 */
export async function updateSupplement(
  userId: number,
  supplementId: number,
  fields: {
    name?: string
    unit?: string
    defaultAmount?: number
    dosesPerDay?: number
    doseIntervalMinutes?: number | null
    reminderEnabled?: boolean
    reminderTime?: string | null
    color?: string | null
    icon?: string | null
  },
): Promise<void> {
  const COLUMNS = {
    name: "name",
    unit: "unit",
    defaultAmount: "default_amount",
    dosesPerDay: "doses_per_day",
    doseIntervalMinutes: "dose_interval_minutes",
    reminderEnabled: "reminder_enabled",
    reminderTime: "reminder_time",
    color: "color",
    icon: "icon",
  } as const

  const setClauses: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, column] of Object.entries(COLUMNS) as [
    keyof typeof COLUMNS,
    string,
  ][]) {
    const value = fields[key]
    if (value === undefined) continue
    setClauses.push(`${column} = ?`)
    if (key === "reminderEnabled") values.push(value ? 1 : 0)
    else if (key === "reminderTime")
      values.push(value ? simpleTimeToMySQL(value as string) : null)
    else values.push(value as string | number | null)
  }

  if (setClauses.length === 0) return

  await pool.execute(
    `UPDATE supplements SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
    [...values, supplementId, userId],
  )
}

/**
 * Deletes a supplement and, by cascade, its intake history.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id`.
 * @returns False when nothing was deleted.
 */
export async function deleteSupplement(
  userId: number,
  supplementId: number,
): Promise<boolean> {
  // The intake history goes with it: fk_si_supplement is ON DELETE CASCADE.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM supplements WHERE id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return result.affectedRows > 0
}

/**
 * Records a dose.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id`.
 * @param amount - Amount taken, in the supplement's unit.
 * @param takenAt - When it was taken. Defaults to now.
 * @param note - Optional free text.
 * @returns The new `supplement_intake.id`.
 */
export async function logSupplement(
  userId: number,
  supplementId: number,
  amount: number,
  takenAt?: string | null,
  note?: string | null,
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO supplement_intake (user_id, supplement_id, amount, taken_at, note)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      supplementId,
      amount,
      formatDateForMySQL(takenAt || new Date()),
      note ?? null,
    ],
  )
  return result.insertId
}

/**
 * Finds the latest dose logged today.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id`.
 * @returns That dose, or null when none was logged today.
 */
export async function hasTakenTodayServer(
  userId: number,
  supplementId: number,
  timeZone = "UTC",
): Promise<SupplementEntry | null> {
  const now = new Date()
  const [rows] = await pool.execute<SupplementEntry[]>(
    `SELECT ${INTAKE_COLS} FROM supplement_intake
     WHERE user_id = ? AND supplement_id = ? AND taken_at >= ?
     ORDER BY taken_at DESC`,
    [userId, supplementId, formatDateForMySQL(new Date(now.getTime() - 2 * DAY_MS))],
  )
  const today = localDay(now, timeZone)
  return (
    rows.find(
      (r) => localDay(parseMySQLDate(String(r.takenAt)), timeZone) === today,
    ) ?? null
  )
}

/**
 * Lists recent doses, newest first.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id`.
 * @param limit - Maximum rows to return.
 */
export async function getHistory(
  userId: number,
  supplementId: number,
  limit = 30,
): Promise<SupplementEntry[]> {
  const [rows] = await pool.execute<SupplementEntry[]>(
    `SELECT ${INTAKE_COLS} FROM supplement_intake
     WHERE user_id = ? AND supplement_id = ?
     ORDER BY taken_at DESC LIMIT ?`,
    [userId, supplementId, limit],
  )
  return rows
}

/**
 * Counts consecutive days with a dose, looking back at most 366 days.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id`.
 * @returns The streak length in days.
 */
export async function getStreak(
  userId: number,
  supplementId: number,
  timeZone = "UTC",
): Promise<number> {
  const doses = dosesByDay(await recentIntake(userId, supplementId), timeZone)
  return streakFromDays([...doses.keys()], localDay(new Date(), timeZone))
}

/**
 * Deletes one logged dose.
 *
 * @param userId - Numeric id of the owner.
 * @param supplementId - `supplements.id` the dose must belong to.
 * @param entryId - `supplement_intake.id`.
 * @returns False when nothing was deleted.
 */
export async function deleteLogEntry(
  userId: number,
  supplementId: number,
  entryId: number,
): Promise<boolean> {
  // scoped to the supplement: an entry id from a different supplement is a 404,
  // not a delete of someone else's row
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM supplement_intake WHERE id = ? AND user_id = ? AND supplement_id = ?`,
    [entryId, userId, supplementId],
  )
  return result.affectedRows > 0
}
