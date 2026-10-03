import { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"
import { findUserForAuth } from "../features/auth/auth.model.js"
import { ForbiddenError, UnauthorizedError } from "./errorHandler.js"
import { isUuid } from "./validation.js"
import { envBool } from "../config/env.js"
import type { JwtPayload } from "../features/auth/auth.types.js"

// Bearer only. `header.split(" ")[1]` also accepted `Basic <jwt>` and
// `Anything <jwt>`. Every one of those failed safely at jwt.verify, but the
// scheme is part of the contract and a caller sending the wrong one deserves
// the 401 to say so rather than "invalid token".
function extractToken(req: Request): string | null {
  const match = /^Bearer +(\S+)$/.exec(req.headers["authorization"] ?? "")
  return match?.[1] ?? null
}

export async function authenticateToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  // Mounted twice on the 2 MB-parser paths (once by server.ts to gate the
  // parser, once by the router), which meant two findUserForAuth queries per
  // program upload on an 8-connection pool.
  if (req.user) return next()

  const token = extractToken(req)
  if (!token) return next(new UnauthorizedError("Access token required"))

  try {
    const { userId, tokenVersion } = jwt.verify(
      token,
      process.env.JWT_SECRET!,
      { algorithms: ["HS256"] },
    ) as JwtPayload
    // A token signed before users had uuids contains a numeric id. Refuse it
    // here rather than let MySQL coerce it into a uuid comparison.
    if (!isUuid(userId)) return next(new UnauthorizedError("Invalid or expired token"))
    // A suspended account reads as not found here (findUserForAuth filters
    // disabled_at), and suspending bumped token_version anyway.
    const found = await findUserForAuth(userId)
    if (!found) return next(new UnauthorizedError("User not found"))
    if (found.tokenVersion !== tokenVersion)
      return next(new UnauthorizedError("Token has been revoked"))
    req.user = found.user
    // No writes until the Terms are accepted (the app records that through
    // PUT /api/auth/consent right after signup), so an account made straight
    // through the API can't store data without a record of accepting them,
    // including the 16+ age clause. /api/auth remains open: it is where the
    // consent is recorded, and signing out or deleting must always work.
    if (
      !found.user.termsAcceptedAt &&
      !["GET", "HEAD", "DELETE"].includes(req.method) &&
      !req.originalUrl.startsWith("/api/auth/") &&
      envBool("REQUIRE_TERMS_ACCEPTANCE", true)
    )
      return next(
        new ForbiddenError("Accept the Terms to continue", "TERMS_NOT_ACCEPTED"),
      )
    next()
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      return next(new UnauthorizedError("Invalid or expired token"))
    }
    // Infrastructure error (e.g. DB down): let it bubble up as a 500
    next(err)
  }
}

/**
 * Admin-only routes. Mount after authenticateToken. isAdmin comes from the
 * row authenticateToken just read, so a demotion applies on the next request.
 */
export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) return next(new UnauthorizedError("Access token required"))
  if (!req.user.isAdmin) return next(new ForbiddenError("Admin access required"))
  next()
}
