// Idempotency-Key for the session write routes. The app sends one when it
// replays an offline-queued write. If the first attempt committed but the
// response never arrived, the replay gets the stored response back instead of
// creating a second session or set.

import { createHash } from "node:crypto"
import type { Request, Response, NextFunction } from "express"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { pool, formatDateForMySQL, parseMySQLDate } from "@/config/database.js"
import { AppError, ValidationError } from "./errorHandler.js"
import { logger } from "@/utils/logger.js"

const TTL_MS = 48 * 60 * 60 * 1000

/**
 * A placeholder this old belongs to a request that never answered (the
 * process died mid-request), and a retry may take the key over. Far longer
 * than any of these handlers run.
 */
const IN_FLIGHT_STALE_MS = 2 * 60 * 1000

/** `status` of a placeholder row: the request holding the key is still running. */
const PENDING = 0

const isDuplicate = (err: unknown) =>
  (err as { code?: string }).code === "ER_DUP_ENTRY"

export async function idempotent(req: Request, res: Response, next: NextFunction) {
  const key = req.get("Idempotency-Key")
  if (key === undefined) return next()
  if (key.length < 1 || key.length > 64)
    throw new ValidationError("Idempotency-Key must be 1-64 characters")

  const userId = req.user!.id
  // A trainer acting as the trainee (req.user swapped by applyTrainerContext)
  // gets their own key space, so the two can't collide or read each other's
  // stored responses.
  const actorId = req.trainer?.userId ?? 0
  const pk = [userId, actorId, key]
  // Includes the path params, so the same key on another session is a mismatch.
  const route = `${req.method} ${req.baseUrl}${req.path}`
  const bodyHash = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex")
  const now = Date.now()

  // The placeholder row is the in-flight lock: whoever inserts it runs the
  // handler, and a concurrent retry with the same key finds it instead of
  // running the write a second time.
  const claim = async (): Promise<boolean> => {
    try {
      await pool.execute(
        `INSERT INTO idempotency_keys
           (user_id, actor_id, idem_key, route, body_hash, status, response, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
        [...pk, route, bodyHash, PENDING, formatDateForMySQL(new Date(now))],
      )
      return true
    } catch (err) {
      if (isDuplicate(err)) return false
      throw err
    }
  }

  if (!(await claim()) && (await replayOrTakeOver(res, claim, { pk, route, bodyHash, now })))
    return

  // From here this request has claimed the placeholder and must settle it exactly
  // once: store a 2xx, or release the key for anything else so a retry runs.
  let settled = false
  const release = () =>
    pool
      .execute(
        `DELETE FROM idempotency_keys
         WHERE user_id = ? AND actor_id = ? AND idem_key = ? AND status = ?`,
        [...pk, PENDING],
      )
      .catch((err: Error) => logger.warn("[IDEMPOTENCY] release failed:", err.message))

  const json = res.json.bind(res)
  res.json = (body: unknown) => {
    /* v8 ignore next -- only a handler that answers twice */
    if (settled) return json(body)
    settled = true
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Released before answering, so a retry sent the moment this 4xx/5xx
      // lands isn't told the key is still in flight.
      release().finally(() => json(body))
      return res
    }
    const text = JSON.stringify(body)
    // Persist before answering: once the client has the response, a replay
    // must find the key.
    pool
      .execute(
        `UPDATE idempotency_keys SET status = ?, response = ?
         WHERE user_id = ? AND actor_id = ? AND idem_key = ?`,
        [res.statusCode, text, ...pk],
      )
      .catch((err: Error) => logger.warn("[IDEMPOTENCY] store failed:", err.message))
      .finally(() => res.type("json").send(text))
    return res
  }
  // Every route behind this answers through res.json. This only catches one
  // that someday doesn't, so its key isn't held until IN_FLIGHT_STALE_MS.
  res.on("finish", () => {
    if (!settled) {
      settled = true
      void release()
    }
  })
  next()
}

/**
 * Delete expired keys across every user, a bounded batch at a time. Run from
 * the periodic cleanup job: the old per-user purge only ran on that same
 * user's next keyed write, so a user who stopped writing kept their rows.
 */
export async function purgeExpiredIdempotencyKeys(batch = 5000): Promise<number> {
  const cutoff = formatDateForMySQL(new Date(Date.now() - TTL_MS))
  const [r] = await pool.execute<ResultSetHeader>(
    `DELETE FROM idempotency_keys WHERE created_at <= ? LIMIT ${Number(batch) | 0}`,
    [cutoff],
  )
  return r.affectedRows
}

/**
 * The key already has a row. Replay its stored response (true), or take an
 * expired or abandoned key over (false). Throws when it is in use.
 */
async function replayOrTakeOver(
  res: Response,
  claim: () => Promise<boolean>,
  { pk, route, bodyHash, now }: { pk: (string | number)[]; route: string; bodyHash: string; now: number },
): Promise<boolean> {
  const [[stored]] = await pool.execute<RowDataPacket[]>(
    `SELECT route, body_hash AS bodyHash, status, response, created_at AS createdAt
     FROM idempotency_keys WHERE user_id = ? AND actor_id = ? AND idem_key = ?`,
    pk,
  )
  const age = stored ? now - parseMySQLDate(stored.createdAt).getTime() : 0
  const expired = age >= TTL_MS
  const abandoned = stored?.status === PENDING && age >= IN_FLIGHT_STALE_MS

  if (stored && !expired) {
    if (stored.route !== route || stored.bodyHash !== bodyHash)
      throw new AppError(
        "Idempotency-Key was already used for a different request",
        422,
        null,
        "IDEMPOTENCY_KEY_REUSED",
      )
    if (stored.status !== PENDING) {
      res.status(stored.status).type("json").send(stored.response)
      return true
    }
  }

  // The row vanished between the INSERT and the SELECT (its request failed
  // and released it), has expired, or was abandoned: take the key over. The
  // UPDATE is conditional on the row we read, so of two retries racing for
  // it exactly one wins.
  let tookOver = false
  if (!stored) tookOver = await claim()
  else if (expired || abandoned) {
    const [r] = await pool.execute<ResultSetHeader>(
      `UPDATE idempotency_keys
       SET route = ?, body_hash = ?, status = ?, response = '', created_at = ?
       WHERE user_id = ? AND actor_id = ? AND idem_key = ?
         AND status = ? AND created_at = ?`,
      [
        route,
        bodyHash,
        PENDING,
        formatDateForMySQL(new Date(now)),
        ...pk,
        stored.status,
        stored.createdAt,
      ],
    )
    tookOver = r.affectedRows === 1
  }
  if (!tookOver) {
    res.set("Retry-After", "2")
    throw new AppError(
      "A request with this Idempotency-Key is still in progress",
      409,
      null,
      "IDEMPOTENCY_KEY_IN_FLIGHT",
    )
  }
  return false
}
