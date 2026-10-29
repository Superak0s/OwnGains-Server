import { createHash } from "node:crypto"
import type { Request, Response, NextFunction } from "express"
import { ipKeyGenerator } from "express-rate-limit"
import { envBool } from "../config/env.js"
import { AppError, ForbiddenError, UnauthorizedError } from "../middleware/errorHandler.js"
import { marketplaceConfig } from "./env.js"

export interface MarketUser {
  uuid: string
  username: string
  isAdmin: boolean
  termsAccepted: boolean
}

const USER_TTL_MS = 60_000
const REJECTED_TTL_MS = 10_000
// ponytail: cleared wholesale at 10,000 tokens, an LRU only if that ever churns the cache.
const MAX_CACHED = 10_000
const cache = new Map<string, { user: MarketUser | null; expires: number }>()

// The account server rate-limits this service as one client, so one caller spraying fresh tokens
// would lock every signed-in user out.
// ponytail: fixed one-minute window per IP (IPv6 grouped by /56 like the limiters), cleared wholesale like the cache.
const LOOKUPS_PER_MINUTE = 30
const lookups = new Map<string, { n: number; resetAt: number }>()
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/

function spendLookup(ip: string): void {
  const now = Date.now()
  const key = ipKeyGenerator(ip)
  let entry = lookups.get(key)
  if (!entry || entry.resetAt <= now) {
    if (lookups.size >= MAX_CACHED) lookups.clear()
    entry = { n: 0, resetAt: now + 60_000 }
    lookups.set(key, entry)
  }
  if (++entry.n > LOOKUPS_PER_MINUTE)
    throw new AppError("Too many sign-in checks. Try again in a minute.", 429, null, "AUTH_RATE_LIMITED")
}

/** Asks the trusted OwnGains server who owns this token. Null means it refused the token. */
async function fetchMe(token: string): Promise<MarketUser | null> {
  let res: globalThis.Response
  try {
    res = await fetch(`${marketplaceConfig.authServerUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new AppError("The account server is unreachable. Try again later.", 503, null, "AUTH_UNAVAILABLE")
  }
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new AppError("The account server is unreachable. Try again later.", 503, null, "AUTH_UNAVAILABLE")
  let body: { user?: { id?: unknown; username?: unknown; isAdmin?: unknown; termsAcceptedAt?: unknown } }
  try {
    body = await res.json()
  } catch {
    throw new AppError("The account server is unreachable. Try again later.", 503, null, "AUTH_UNAVAILABLE")
  }
  const u = body?.user
  if (typeof u?.id !== "string" || typeof u.username !== "string") return null
  return { uuid: u.id, username: u.username, isAdmin: u.isAdmin === true, termsAccepted: !!u.termsAcceptedAt }
}

async function resolveUser(token: string, ip: string): Promise<MarketUser | null> {
  if (!JWT_SHAPE.test(token)) return null
  const key = createHash("sha256").update(token).digest("hex")
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.user
  spendLookup(ip)
  const user = await fetchMe(token)
  if (cache.size >= MAX_CACHED) cache.clear()
  cache.set(key, { user, expires: Date.now() + (user ? USER_TTL_MS : REJECTED_TTL_MS) })
  return user
}

const bearerToken = (req: Request): string | null => {
  const header = req.get("authorization")
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || null : null
}

/**
 * Sets `res.locals.marketUser` when a valid token is sent. A rejected token, or an account server
 * that can't be reached, is treated as anonymous so browsing keeps working. The lookup error is kept
 * for `authFailure`, so a route that only works signed in reports it instead of 401 or 404.
 */
export async function optionalUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req)
  res.locals.marketUser = token
    ? ((await resolveUser(token, req.ip ?? "").catch((err: unknown) => {
        res.locals.authError = err
        return null
      })) ?? undefined)
    : undefined
  next()
}

/** The account-server error `optionalUser` swallowed, if any. */
export const authFailure = (res: Response): unknown => res.locals.authError

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req)
  const user = token ? await resolveUser(token, req.ip ?? "") : null
  if (!user) throw new UnauthorizedError("Sign in to your OwnGains account first")
  res.locals.marketUser = user
  next()
}

/** Publishing, rating and reporting need recorded Terms acceptance, as writes on the account server do. Deletes pass. */
export function requireTerms(_req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(res)!.termsAccepted && envBool("REQUIRE_TERMS_ACCEPTANCE", true))
    throw new ForbiddenError("Accept the Terms in the app to continue", "TERMS_NOT_ACCEPTED")
  next()
}

export const currentUser = (res: Response): MarketUser | undefined => res.locals.marketUser as MarketUser | undefined
