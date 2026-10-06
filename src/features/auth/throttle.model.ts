import { createHash } from "node:crypto"
import type { RowDataPacket } from "mysql2"
import { pool } from "@/config/database.js"
import { AppError } from "@/middleware/errorHandler.js"
import { logger } from "@/utils/logger.js"

/**
 * Per-subject failure throttle with exponential backoff, stored in MySQL so it
 * is shared by every process and is kept across a restart (the per-IP limiters in
 * server.ts are in-memory and can't see credential stuffing spread across
 * many IPs).
 *
 * - `signin` is keyed by the username/email exactly as submitted, normalised,
 *   never by the account it resolves to: keying by account would let a caller
 *   learn which email belongs to which username from which one got locked. An
 *   unknown name is throttled exactly like a real one.
 * - `reauth` is keyed by user uuid and covers the password re-checks behind
 *   an authenticated session (change password, delete account, email change).
 *
 * The first FREE_FAILURES misses inside the window cost nothing. After that
 * each miss locks the subject for 30s, doubling up to MAX_LOCK_SECONDS. A
 * success clears the row. The trade-off is the usual one: someone who knows a
 * username can keep it locked, capped at 15 minutes per miss, but only
 * against new signins. Devices that already have a refresh token are unaffected.
 */

export type ThrottleScope = "signin" | "reauth"

const FREE_FAILURES = 5
const BASE_LOCK_SECONDS = 30
const MAX_LOCK_SECONDS = 15 * 60
/** A miss older than this starts the count from scratch. */
const WINDOW_HOURS = 1

const subjectHash = (subject: string): string =>
  createHash("sha256").update(subject.trim().toLowerCase()).digest("hex")

export function lockSecondsFor(failures: number): number {
  if (failures <= FREE_FAILURES) return 0
  return Math.min(
    MAX_LOCK_SECONDS,
    BASE_LOCK_SECONDS * 2 ** (failures - FREE_FAILURES - 1),
  )
}

export class ThrottledError extends AppError {
  retryAfter: number
  constructor(retryAfter: number) {
    super(
      "Too many failed attempts. Try again later.",
      429,
      { retryAfter },
      "AUTH_THROTTLED",
    )
    this.retryAfter = retryAfter
  }
}

/** Throws ThrottledError while the subject is locked out. */
export async function assertNotThrottled(
  scope: ThrottleScope,
  subject: string,
): Promise<void> {
  const [rows] = await pool.execute<(RowDataPacket & { wait: number })[]>(
    `SELECT TIMESTAMPDIFF(SECOND, NOW(), locked_until) AS wait
     FROM auth_throttle
     WHERE scope = ? AND subject_hash = ? AND locked_until > NOW()`,
    [scope, subjectHash(subject)],
  )
  if (rows[0]) throw new ThrottledError(Math.max(1, Number(rows[0].wait)))
}

export async function recordFailure(
  scope: ThrottleScope,
  subject: string,
): Promise<void> {
  const hash = subjectHash(subject)
  // failures is assigned before last_failure_at, so its IF still reads the
  // previous miss's timestamp.
  await pool.execute(
    `INSERT INTO auth_throttle (scope, subject_hash, failures, last_failure_at)
     VALUES (?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE
       failures = IF(last_failure_at < NOW() - INTERVAL ${WINDOW_HOURS} HOUR, 1, failures + 1),
       last_failure_at = NOW()`,
    [scope, hash],
  )
  const [rows] = await pool.execute<(RowDataPacket & { failures: number })[]>(
    `SELECT failures FROM auth_throttle WHERE scope = ? AND subject_hash = ?`,
    [scope, hash],
  )
  const lock = lockSecondsFor(Number(rows[0]?.failures ?? 0))
  if (lock > 0) {
    await pool.execute(
      `UPDATE auth_throttle SET locked_until = NOW() + INTERVAL ? SECOND
       WHERE scope = ? AND subject_hash = ?`,
      [lock, scope, hash],
    )
    logger.warn("[AUDIT] sign-in lockout", { scope, subject: hash.slice(0, 12), seconds: lock })
  }

  // Rows for subjects that stopped failing are dead weight. Swept here, on
  // the failure path only, in small batches, rather than by another timer.
  if (Math.random() < 0.05) await purgeStaleThrottles(500)
}

export async function purgeStaleThrottles(limit = 5000): Promise<void> {
  await pool.execute(
    `DELETE FROM auth_throttle
     WHERE last_failure_at < NOW() - INTERVAL 1 DAY
       AND (locked_until IS NULL OR locked_until < NOW())
     LIMIT ${limit | 0}`,
  )
}

export async function clearFailures(
  scope: ThrottleScope,
  subject: string,
): Promise<void> {
  await pool.execute(
    `DELETE FROM auth_throttle WHERE scope = ? AND subject_hash = ?`,
    [scope, subjectHash(subject)],
  )
}
