import { Router, Request, Response } from "express"
import { authenticateToken, requireAdmin } from "@/middleware/auth.js"
import { ForbiddenError, NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import { queryLimit } from "@/middleware/validation.js"
import { findUserById, requireUser, setUserDisabled } from "./auth.model.js"
import { listReports } from "@/features/social/friends/friends.model.js"
import { logger } from "@/utils/logger.js"

/**
 * /api/admin: moderation for whoever runs this instance. Everything here is
 * also reachable from the `owngains` CLI. This is the same thing for an
 * operator who would rather not open a shell on the box.
 */
const router: Router = Router()

router.use(authenticateToken, requireAdmin)

router.get("/reports", async (req: Request, res: Response) => {
  const rows = await listReports(queryLimit(req, { def: 100, max: 500 }))
  logger.warn("[AUDIT] admin read reports", { actor: req.user!.uuid, count: rows.length })
  res.json({
    success: true,
    reports: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      details: r.details,
      createdAt: r.created_at,
      reporter: r.reporter_uuid
        ? { id: r.reporter_uuid, username: r.reporter_username }
        : null,
      reported: {
        id: r.reported_uuid,
        username: r.reported_username,
        deleted: !r.reported_exists,
        suspended: !!r.reported_disabled,
      },
    })),
  })
})

/**
 * Suspend: the account can't sign in, refresh or use any token it already
 * holds (token_version is bumped and every refresh token revoked). Nothing is
 * deleted, so unsuspending restores it as it was. An admin can't be
 * suspended from here (demote them with the CLI first), which also means no
 * one can lock themselves out this way.
 */
router.post("/users/:userId/suspend", async (req: Request, res: Response) => {
  const target = await requireUser(req.params.userId, "user ID")
  const user = await findUserById(target.id)
  /* v8 ignore next -- race: requireUser just found this row */
  if (!user) throw new NotFoundError("User")
  if (user.isAdmin)
    throw new ForbiddenError("Cannot suspend an admin; revoke admin first")
  // DSA Art. 17: the user is told why at their next sign-in.
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : ""
  if (!reason || reason.length > 500)
    throw new ValidationError("reason is required (at most 500 characters)")
  await setUserDisabled(target.id, true, reason)
  logger.warn("[AUDIT] admin suspend", { actor: req.user!.uuid, target: user.uuid })
  res.json({ success: true, message: "User suspended" })
})

router.post("/users/:userId/unsuspend", async (req: Request, res: Response) => {
  const target = await requireUser(req.params.userId, "user ID")
  await setUserDisabled(target.id, false)
  logger.warn("[AUDIT] admin unsuspend", { actor: req.user!.uuid, target: target.uuid })
  res.json({ success: true, message: "User unsuspended" })
})

export default router
