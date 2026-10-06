// Every per-user preference, in one row of one table.
//
// This replaces hydration_settings, menstrual_settings and macros_goals, three
// tables that were each one row per user with a handful of NOT NULL columns and
// a hand-rolled COALESCE upsert. A new preference is a new column here, never a
// new table.

import { pool } from "@/config/database.js"
import type { RowDataPacket } from "mysql2"
import { NotFoundError, throwCheckViolation } from "@/middleware/errorHandler.js"

/** Wire (camelCase) name → column name. The only map of the two. */
const COLUMNS = {
  hydrationGoalMl: "hydration_goal_ml",
  hydrationErrorPercent: "hydration_error_percent",
  cyclePeriodDays: "cycle_period_days",
  cycleLengthDays: "cycle_length_days",
  macroProteinGoal: "macro_protein_goal",
  macroCarbsGoal: "macro_carbs_goal",
  macroFatGoal: "macro_fat_goal",
  macroCaloriesGoal: "macro_calories_goal",
} as const

export type SettingKey = keyof typeof COLUMNS

export const SETTING_KEYS = Object.keys(COLUMNS) as SettingKey[]

/** Keys whose column is an integer type: MySQL silently rounds 5.7 to 6. */
export const INTEGER_SETTING_KEYS: ReadonlySet<SettingKey> = new Set([
  "hydrationGoalMl",
  "cyclePeriodDays",
  "cycleLengthDays",
])

type UserSettings = Record<SettingKey, number> & {
  updatedAt: Date | string | null
}

const SELECT_COLS = Object.entries(COLUMNS)
  .map(([alias, col]) => `${col} AS ${alias}`)
  .join(", ")

/**
 * The caller's settings, creating the row on first read so the DDL defaults in
 * schema.sql remain the one source of truth for what a default is. There is
 * no duplicate default table in TypeScript to drift out of sync.
 */
export async function getUserSettings(userId: number): Promise<UserSettings> {
  const read = async () =>
    (
      await pool.execute<RowDataPacket[]>(
        `SELECT ${SELECT_COLS}, updated_at AS updatedAt FROM user_settings WHERE user_id = ?`,
        [userId],
      )
    )[0][0]

  let row = await read()
  if (!row) {
    await pool.execute(`INSERT IGNORE INTO user_settings (user_id) VALUES (?)`, [
      userId,
    ])
    row = await read()
  }
  // INSERT IGNORE swallows the FK violation if the user row vanished between
  // authenticateToken and here, and the cast would then serialize `undefined`
  // as a 200 with no data.
  if (!row) throw new NotFoundError("User")
  return row as unknown as UserSettings
}

/**
 * Write the provided settings and leave the rest alone. Keys absent from
 * `patch` (or explicitly undefined/null) are not touched. On a first write the
 * untouched columns take their schema defaults.
 */
export async function updateUserSettings(
  userId: number,
  patch: Partial<Record<SettingKey, number | null | undefined>>,
): Promise<void> {
  const keys = (Object.keys(COLUMNS) as SettingKey[]).filter(
    (k) => patch[k] != null,
  )
  if (keys.length === 0) return

  const cols = keys.map((k) => COLUMNS[k])
  try {
    await pool.execute(
      `INSERT INTO user_settings (user_id, ${cols.join(", ")})
       VALUES (?${", ?".repeat(cols.length)})
       ON DUPLICATE KEY UPDATE ${cols.map((c) => c + " = VALUES(" + c + ")").join(", ")}`,
      [userId, ...keys.map((k) => patch[k] as number)],
    )
  } catch (err) {
    // ck_us_* in schema.sql hold the real ranges (a period no longer than the
    // cycle, a positive hydration goal). They are the rule, so the route does
    // not restate them, but a violated CHECK is a bad request, not a 500.
    throwCheckViolation(err, `Setting out of range: ${keys.join(", ")}`)
  }
}
