import rateLimit from "express-rate-limit"

/**
 * A limiter keyed by account rather than by IP, for routes behind
 * `authenticateToken`. Off under vitest.
 *
 * @param prefix - Key prefix, one per limiter.
 * @param windowMs - Window length in milliseconds.
 * @param limit - Requests allowed per window.
 * @param error - The `error` of the 429 body.
 */
export function userRateLimit(prefix: string, windowMs: number, limit: number, error: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${prefix}:${req.user!.id}`,
    skip: () => !!process.env.VITEST,
    message: { success: false, error },
  })
}
