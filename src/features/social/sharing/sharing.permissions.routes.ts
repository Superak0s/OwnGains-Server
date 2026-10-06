// Permission grants between friends, and the friend-history reads they gate.
// Mounted by sharing.routes.ts, which runs authenticateToken first.

import { Router, Request, Response } from "express"
import {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "@/middleware/errorHandler.js"
import {
  grantPermission,
  revokePermission,
  getPermissions,
  getPermissionPayload,
  MAX_PAYLOAD_BYTES,
  resolveFriendAccess,
  getFriendSessions,
  getFriendSessionDetails,
} from "./sharing.model.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import {
  historyCursor,
  parseHistoryCursor,
} from "@/features/workouts/workouts.model.js"

const router: Router = Router()

router.post("/permissions", async (req: Request, res: Response) => {
  const { friendId, permissionType, payload } = req.body

  if (!friendId) throw new ValidationError("friendId is required")
  if (!permissionType) throw new ValidationError("permissionType is required")

  if (permissionType === "program") {
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !payload.programData
    )
      throw new ValidationError(
        "payload.programData is required for program permission",
      )
    // The 2 MB parser in front of this route is shared with program upload.
    // A snapshot handed to a friend gets a much smaller ceiling.
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES)
      throw new AppError(
        `payload must not exceed ${MAX_PAYLOAD_BYTES / 1024} KB`,
        413,
        null,
        "PAYLOAD_TOO_LARGE",
      )
  }

  const friend = await resolveFriendAccess(req.user!.id, friendId, "friendId", null)

  if (!friend.friends) {
    throw new ForbiddenError("Can only grant permissions to friends")
  }

  const permissionId = await grantPermission(
    req.user!.id,
    friend.id,
    permissionType,
    payload ?? null,
  )

  res
    .status(201)
    .json({ success: true, message: "Permission granted", permissionId })
})

// Payloads are left out of the lists unless asked for. See getPermissions.
const includePayload = (req: Request) => req.query.includePayload === "true"

router.get("/permissions/granted", async (req: Request, res: Response) => {
  const permissions = await getPermissions(req.user!.id, "granted", {
    includePayload: includePayload(req),
  })
  res.json({ success: true, permissions })
})

router.get("/permissions/received", async (req: Request, res: Response) => {
  const permissions = await getPermissions(req.user!.id, "received", {
    includePayload: includePayload(req),
  })
  res.json({ success: true, permissions })
})

router.get("/permissions/:permissionId/payload", async (req: Request, res: Response) => {
  const permissionId = parseIntParam(String(req.params.permissionId), "permissionId")
  const found = await getPermissionPayload(req.user!.id, permissionId)
  if (!found) throw new NotFoundError("Permission")
  res.json({ success: true, payload: found.payload })
})

router.delete("/permissions/:permissionId", async (req: Request, res: Response) => {
  const permissionId = parseIntParam(String(req.params.permissionId), "permissionId")
  await revokePermission(req.user!.id, permissionId)
  res.json({ success: true, message: "Permission revoked" })
})

router.get("/sessions/friend/:friendId", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 60, max: 200 })
  const {
    id: friendId,
    friends,
    granted: allowed,
  } = await resolveFriendAccess(req.user!.id, req.params.friendId, "friendId", "history")
  if (!friends) throw new ForbiddenError("Can only view sessions of friends")
  if (!allowed)
    throw new ForbiddenError("Friend hasn't granted you history access")

  const rawBefore = typeof req.query.before === "string" ? req.query.before : ""
  const before = rawBefore ? parseHistoryCursor(rawBefore) : null
  if (rawBefore && !before)
    throw new ValidationError("before must be a nextCursor from a previous page")

  const sessions = await getFriendSessions(
    friendId,
    limit,
    req.query.includeTimings === "true",
    before,
  )
  // nextCursor, as on GET /api/sessions: null on the last page.
  const last = sessions.at(-1)
  res.json({
    success: true,
    sessions,
    // start_time is NOT NULL. The row type is just wider than the column.
    nextCursor:
      sessions.length === limit && last
        ? historyCursor({ startTime: String(last.startTime), id: last.id })
        : null,
  })
})

router.get("/sessions/friend/:friendId/:sessionId", async (req: Request, res: Response) => {
  const sessionId = parseIntParam(String(req.params.sessionId), "sessionId")
  const {
    id: friendId,
    friends,
    granted: allowed,
  } = await resolveFriendAccess(req.user!.id, req.params.friendId, "friendId", "history")
  if (!friends) throw new ForbiddenError("Can only view sessions of friends")
  if (!allowed)
    throw new ForbiddenError("Friend hasn't granted you history access")

  const session = await getFriendSessionDetails(friendId, sessionId)
  if (!session) throw new NotFoundError("Session")

  res.json({ success: true, session })
})

export default router
