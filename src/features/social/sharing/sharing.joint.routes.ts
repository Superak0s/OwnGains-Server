// Joint sessions: status, invites, progress and leave.
// Mounted by sharing.routes.ts, which runs authenticateToken first.

import { Router, Request, Response } from "express"
import { parseMySQLDate } from "@/config/database.js"
import { ValidationError, NotFoundError, ForbiddenError } from "@/middleware/errorHandler.js"
import { sendToUser, notifyJointProgress, notifyJointSessionEnded } from "@/ws/wsServer.js"
import {
  resolveFriendAccess,
  createJointInvite,
  getInvite,
  acceptInvite,
  declineInvite,
  getJointSession,
  updateParticipantProgress,
  endJointSession,
  getUserActiveSessionStatus,
  getFriendsActiveSessionStatuses,
} from "./sharing.model.js"
import { parseIntParam, isUuid } from "@/middleware/validation.js"

const router: Router = Router()

const MAX_STATUS_FRIEND_IDS = 100

/**
 * GET /joint-sessions/status?friendIds=<uuid>,<uuid>,…
 *
 * The single-friend status route below, for up to 100 friends in one request.
 * An id that isn't an accepted friend (or isn't a uuid at all) is left out
 * of `statuses` rather than failing the batch.
 */
router.get("/joint-sessions/status", async (req: Request, res: Response) => {
  const raw = req.query.friendIds
  const ids =
    typeof raw === "string"
      ? [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))]
      : []
  if (ids.length === 0) throw new ValidationError("friendIds is required")
  if (ids.length > MAX_STATUS_FRIEND_IDS)
    throw new ValidationError("Too many friend ids")

  const statuses = await getFriendsActiveSessionStatuses(
    req.user!.id,
    ids.filter(isUuid),
  )
  res.json({ success: true, statuses })
})

router.get("/joint-sessions/friend/:friendId/status", async (req: Request, res: Response) => {
  const { uuid, friends } = await resolveFriendAccess(
    req.user!.id,
    req.params.friendId,
    "friendId",
    null,
  )
  if (!friends) throw new ForbiddenError("Not friends")

  const statuses = await getFriendsActiveSessionStatuses(req.user!.id, [uuid])
  res.json({ success: true, ...statuses[uuid] })
})

router.post("/joint-sessions/invite", async (req: Request, res: Response) => {
  const { toUserId } = req.body

  if (!toUserId) throw new ValidationError("toUserId is required")
  const toUser = await resolveFriendAccess(req.user!.id, toUserId, "toUserId", "joint_session")

  if (!toUser.friends) throw new ForbiddenError("Can only invite friends")
  if (!toUser.granted)
    throw new ForbiddenError("This friend hasn't allowed joint workout invites from you")

  const myStatus = await getUserActiveSessionStatus(req.user!.id)
  if (!myStatus.hasActiveSession) {
    throw new ValidationError(
      "You must have an active workout session to send a joint invite",
    )
  }

  const inviteId = await createJointInvite(
    req.user!.id,
    toUser.id,
    myStatus.sessionId,
  )

  sendToUser(toUser.uuid, "joint_invite", {
    inviteId,
    fromUserId: req.user!.uuid,
    fromUsername: req.user!.username,
    fromSessionId: myStatus.sessionId,
  })

  res.status(201).json({ success: true, inviteId })
})

router.post("/joint-sessions/invites/:inviteId/accept", async (req: Request, res: Response) => {
  const inviteId = parseIntParam(String(req.params.inviteId), "inviteId")

  const invite = await getInvite(inviteId)
  if (!invite || parseMySQLDate(invite.expires_at) < new Date())
    throw new NotFoundError("Invite")
  if (invite.to_user_id !== req.user!.id)
    throw new ForbiddenError("This invite is not for you")

  const myStatus = await getUserActiveSessionStatus(req.user!.id)
  if (!myStatus.hasActiveSession) {
    throw new ValidationError(
      "You must have an active workout session to join a joint session",
    )
  }

  const { jointSessionId } = await acceptInvite(
    inviteId,
    req.user!.id,
    myStatus.sessionId,
  )

  const jointSession = await getJointSession(jointSessionId)
  /* v8 ignore next -- only if the session is deleted mid-request */
  if (!jointSession) throw new Error("Joint session not found after accept")

  const sender = jointSession.participants.find(
    (p) => p.userId !== req.user!.uuid,
  )
  /* v8 ignore next -- the sender is always the other participant */
  if (sender)
    sendToUser(sender.userId, "invite_status", {
      status: "accepted",
      jointSession,
    })

  res.json({ success: true, jointSession })
})

router.post("/joint-sessions/invites/:inviteId/decline", async (req: Request, res: Response) => {
  const inviteId = parseIntParam(String(req.params.inviteId), "inviteId")
  const invite = await getInvite(inviteId)

  await declineInvite(inviteId, req.user!.id)

  /* v8 ignore next -- declineInvite already 404d a missing invite */
  if (invite)
    sendToUser(invite.from_user_uuid, "invite_status", {
      status: "declined",
      jointSession: null,
    })
  res.json({ success: true, message: "Invite declined" })
})

router.patch("/joint-sessions/:jointSessionId/progress", async (req: Request, res: Response) => {
  const {
    exerciseIndex,
    setIndex,
    exerciseName,
    readyForNext,
    exerciseNames,
  } = req.body
  const jointSessionId = parseIntParam(
    String(req.params.jointSessionId),
    "jointSessionId",
  )

  // Broadcast the stored values, not the raw body: updateParticipantProgress
  // sanitises out-of-range indices, so the two disagreed.
  const stored = await updateParticipantProgress(jointSessionId, req.user!.id, {
    exerciseIndex: exerciseIndex ?? null,
    setIndex: setIndex ?? null,
    exerciseName: exerciseName ?? null,
    readyForNext: readyForNext || false,
    exerciseNames: exerciseNames ?? null,
  })

  const session = await getJointSession(jointSessionId)
  /* v8 ignore next -- the update above 404s a session that is gone */
  if (session) notifyJointProgress(session, req.user!.uuid, stored)

  res.json({ success: true })
})

router.delete("/joint-sessions/:jointSessionId/leave", async (req: Request, res: Response) => {
  const jointSessionId = parseIntParam(
    String(req.params.jointSessionId),
    "jointSessionId",
  )
  const { partnerId } = await endJointSession(jointSessionId, req.user!.id)
  notifyJointSessionEnded(partnerId, jointSessionId)

  res.json({ success: true, message: "Left joint session" })
})

export default router
