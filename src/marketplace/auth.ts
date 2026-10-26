import { createHash } from "node:crypto"
import type { Request, Response, NextFunction } from "express"
import { AppError, UnauthorizedError } from "../middleware/errorHandler.js"
import { marketplaceConfig } from "./env.js"

export interface MarketUser {
  uuid: string
  username: string
  isAdmin: boolean
}

const USER_TTL_MS = 60_000
const REJECTED_TTL_MS = 10_000
// ponytail: cleared wholesale at 10,000 tokens, an LRU only if that ever churns the cache.
const MAX_CACHED = 10_000
const cache = new Map<string, { user: MarketUser | null; expires: number }>()

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
  const body = (await res.json()) as { user?: { id?: unknown; username?: unknown; isAdmin?: unknown } }
  const u = body.user
  if (typeof u?.id !== "string" || typeof u.username !== "string") return null
  return { uuid: u.id, username: u.username, isAdmin: u.isAdmin === true }
}

async function resolveUser(token: string): Promise<MarketUser | null> {
  const key = createHash("sha256").update(token).digest("hex")
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.user
  const user = await fetchMe(token)
  if (cache.size >= MAX_CACHED) cache.clear()
  cache.set(key, { user, expires: Date.now() + (user ? USER_TTL_MS : REJECTED_TTL_MS) })
  return user
}

const bearerToken = (req: Request): string | null => {
  const header = req.get("authorization")
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || null : null
}

/** Sets `res.locals.marketUser` when a valid token is sent. A rejected token is treated as anonymous. */
export async function optionalUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req)
  res.locals.marketUser = token ? ((await resolveUser(token)) ?? undefined) : undefined
  next()
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req)
  const user = token ? await resolveUser(token) : null
  if (!user) throw new UnauthorizedError("Sign in to your OwnGains account first")
  res.locals.marketUser = user
  next()
}

export const currentUser = (res: Response): MarketUser | undefined => res.locals.marketUser as MarketUser | undefined
