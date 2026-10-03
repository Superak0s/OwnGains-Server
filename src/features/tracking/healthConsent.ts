import type { Request, Response, NextFunction } from "express"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { envBool } from "@/config/env.js"
import { pool, withTransaction } from "@/config/database.js"
import { ForbiddenError } from "@/middleware/errorHandler.js"

// Health data is GDPR Art. 9, so a box may only store workouts or tracking
// for owners who gave explicit consent, recorded on the account
// (users.health_consent_at). On by default. An operator whose users still run
// app builds that never send the consent can set REQUIRE_HEALTH_CONSENT=false.
export const healthConsentGuard = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  // Reads and deletes remain open: someone who withdrew consent must still be
  // able to see and erase what was stored (Art. 15, 17).
  if (["GET", "HEAD", "DELETE"].includes(req.method)) return next()
  if (!envBool("REQUIRE_HEALTH_CONSENT", true)) return next()
  if (!req.user?.healthConsentAt)
    throw new ForbiddenError(
      "Health consent is required to store health and workout data",
      "HEALTH_CONSENT_REQUIRED",
    )
  next()
}

/**
 * The user-keyed tables each local-only-capable feature writes. Child tables
 * (soreness_follow_up, progress_photo_muscles, progress_photo_blobs,
 * supplement_intake) go with their parent via ON DELETE CASCADE.
 */
export const HEALTH_TABLES = {
  tracking: [
    "measurements",
    "metric_definitions",
    "macros_intake",
    "soreness",
    "injuries",
    "menstrual_cycle",
    "muscle_notes",
    "progress_photos",
    "user_settings",
  ],
  supplements: ["supplements"],
  // Only erased on a user's own withdrawal, never by purge-local-only.
  // idempotency_keys: stored replay responses contain the rows they created.
  workouts: ["workouts", "idempotency_keys"],
} as const

export type HealthFeature = keyof typeof HEALTH_TABLES

/**
 * Delete the health data of the given features, for one user (consent
 * withdrawal) or for everyone when userId is null (`owngains purge-local-only`).
 * Returns rows deleted per parent table.
 */
export async function deleteHealthData(
  userId: number | null,
  features: readonly HealthFeature[] = ["tracking", "supplements"],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  await withTransaction(async (conn) => {
    for (const f of features)
      for (const table of HEALTH_TABLES[f]) {
        const [r] = await conn.execute<ResultSetHeader>(
          userId === null
            ? `DELETE FROM ${table}`
            : `DELETE FROM ${table} WHERE user_id = ?`,
          userId === null ? [] : [userId],
        )
        counts[table] = r.affectedRows
      }
    // Height and the body-fat formula's sex are body stats kept on the
    // profile row itself.
    if (features.includes("tracking")) {
      const [r] = await conn.execute<ResultSetHeader>(
        `UPDATE users SET height_cm = NULL, bf_formula_sex = NULL
         WHERE (height_cm IS NOT NULL OR bf_formula_sex IS NOT NULL)
           ${userId === null ? "" : "AND id = ?"}`,
        userId === null ? [] : [userId],
      )
      counts["users (height, sex)"] = r.affectedRows
    }
  })
  return counts
}

/** Rows per parent table, for the purge command's dry run. */
export async function countHealthData(
  features: readonly HealthFeature[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const f of features)
    for (const table of HEALTH_TABLES[f]) {
      const [rows] = await pool.query<(RowDataPacket & { n: number })[]>(
        `SELECT COUNT(*) AS n FROM ${table}`,
      )
      counts[table] = Number(rows[0].n)
    }
  if (features.includes("tracking")) {
    const [rows] = await pool.query<(RowDataPacket & { n: number })[]>(
      "SELECT COUNT(*) AS n FROM users WHERE height_cm IS NOT NULL OR bf_formula_sex IS NOT NULL",
    )
    counts["users (height, sex)"] = Number(rows[0].n)
  }
  return counts
}
