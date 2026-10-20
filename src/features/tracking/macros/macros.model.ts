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

/**
 * Records a meal or food intake.
 *
 * @param userId - Numeric id of the owner.
 * @param entry - The intake.
 * @param entry.name - Food name, or null.
 * @param entry.protein - Protein in grams, or null.
 * @param entry.carbs - Carbohydrates in grams, or null.
 * @param entry.fat - Fat in grams, or null.
 * @param entry.calories - Energy in kcal, or null.
 * @param entry.errorMargin - Uncertainty of the figures, in percent.
 * @param entry.takenAt - When it was eaten.
 * @param entry.note - Optional free text.
 * @returns The stored entry.
 */
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
      errorMargin,
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

/**
 * Lists intake entries from the last days, newest first, with a row cap.
 *
 * @param userId - Numeric id of the owner.
 * @param days - Length of the window in days (clamped by the caller to 365).
 */
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

/**
 * Deletes an intake entry.
 *
 * @param userId - Numeric id of the owner.
 * @param entryId - Id of the entry.
 * @returns False when nothing was deleted.
 */
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
