import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { requireOptionalNote } from "@/middleware/validation.js"
import type { MacrosEntry } from "../tracking.types.js"

type MacrosIntakeRow = MacrosEntry & RowDataPacket

// Aliased to camelCase in SQL, so the query result is already the wire shape.
// The `+ 0` casts these columns used to have are gone: the pool sets
// `decimalNumbers: true`, so DECIMAL already arrives as a number.
const MACROS_COLS = `id, name, protein, carbs, fat, calories,
       error_margin AS errorMargin, taken_at AS takenAt, note`

export async function logMacrosIntake(
  userId: number,
  entry: {
    name: string | null
    protein: number | null
    carbs: number | null
    fat: number | null
    calories: number | null
    errorMargin: number
    takenAt: string
    note?: string | null
  },
): Promise<MacrosIntakeRow> {
  const { name, protein, carbs, fat, calories, errorMargin, takenAt, note } = entry
  const ts = formatDateForMySQL(takenAt)
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO macros_intake (user_id, name, protein, carbs, fat, calories, error_margin, taken_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      name ?? null,
      // The columns are NOT NULL DEFAULT 0. An unlogged macro is zero of it,
      // which is what every reader of this table already assumed.
      protein ?? 0,
      carbs ?? 0,
      fat ?? 0,
      calories ?? 0,
      errorMargin ?? 0,
      ts,
      requireOptionalNote(note) ?? null,
    ],
  )
  const [rows] = await pool.execute<MacrosIntakeRow[]>(
    `SELECT ${MACROS_COLS} FROM macros_intake WHERE id = ?`,
    [result.insertId],
  )
  return rows[0]
}

export async function getMacrosHistory(
  userId: number,
  days = 30,
): Promise<MacrosEntry[]> {
  const [rows] = await pool.execute<MacrosIntakeRow[]>(
    // Row guard on top of the date bound: `days` is clamped to 365, but a
    // heavy logger still has thousands of entries in that window and nothing
    // else caps the response.
    `SELECT ${MACROS_COLS} FROM macros_intake
     WHERE user_id = ? AND taken_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY taken_at DESC LIMIT 2000`,
    [userId, days],
  )
  return rows
}

export async function deleteMacrosEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    "DELETE FROM macros_intake WHERE id = ? AND user_id = ?",
    [entryId, userId],
  )
  return result.affectedRows > 0
}
