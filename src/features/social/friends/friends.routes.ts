import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  NotFoundError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  removeFriend,
  getFriends,
  getPendingRequests,
  getSentRequests,
  searchUsers,
  blockUser,
  unblockUser,
  getBlockedUsers,
  reportUser,
  REPORT_REASONS,
  type ReportReason,
} from "./friends.model.js"
import { findUserByUsername, requireUser } from "@/features/auth/auth.model.js"
import { queryLimit, queryString, parseIntParam } from "@/middleware/validation.js"

const router: Router = Router()

router.use(authenticateToken)

router.get("/search", async (req: Request, res: Response) => {
  // queryString: a repeated ?q=a&q=b arrives as an array.
  const q = queryString(req, "q")?.trim() ?? ""

  // Username prefix only, from 3 characters. See searchUsers for why.
  const users = await searchUsers(
    q,
    req.user!.id,
    queryLimit(req, { def: 10, max: 20 }),
  )

  res.json({ success: true, users })
})

/**
 * GET /?include=requests adds `pendingRequests` and `sentRequests` (the same
 * lists /requests/pending and /requests/sent return), so the social screen
 * loads in one round trip instead of three. Without it the response is
 * unchanged.
 */
router.get("/", async (req: Request, res: Response) => {
  const include = req.query.include
  if (include !== undefined && include !== "requests")
    throw new ValidationError('include must be "requests"')
  if (include !== "requests") {
    res.json({ success: true, friends: await getFriends(req.user!.id) })
    return
  }
  const [friends, pendingRequests, sentRequests] = await Promise.all([
    getFriends(req.user!.id),
    getPendingRequests(req.user!.id),
    getSentRequests(req.user!.id),
  ])
  res.json({ success: true, friends, pendingRequests, sentRequests })
})

router.get("/requests/pending", async (req: Request, res: Response) => {
  const requests = await getPendingRequests(req.user!.id)
  res.json({ success: true, requests })
})

router.get("/requests/sent", async (req: Request, res: Response) => {
  const requests = await getSentRequests(req.user!.id)
  res.json({ success: true, requests })
})

router.post("/request", async (req: Request, res: Response) => {
  const { username } = req.body

  if (typeof username !== "string" || !username) {
    throw new ValidationError("Username is required")
  }

  // Cheap self-request check before any DB round-trip
  if (username === req.user!.username) {
    throw new ValidationError("Cannot send friend request to yourself")
  }

  const targetUser = await findUserByUsername(username)

  if (!targetUser) {
    throw new NotFoundError("User")
  }

  // Belt-and-suspenders ID check (handles username case-sensitivity edge cases)
  if (targetUser.id === req.user!.id) {
    throw new ValidationError("Cannot send friend request to yourself")
  }

  const friendshipId = await sendFriendRequest(req.user!.id, targetUser.id)

  const { sendToUser } = await import("@/ws/wsServer.js")
  sendToUser(targetUser.uuid, "friend_request_received", {
    friendshipId,
    fromUserId: req.user!.uuid,
    fromUsername: req.user!.username,
  })

  res.status(201).json({
    success: true,
    message: "Friend request sent",
    friendshipId,
  })
})

router.post("/request/:friendshipId/accept", async (req: Request, res: Response) => {
  const friendshipId = parseIntParam(String(req.params.friendshipId), "friendship ID")

  await acceptFriendRequest(req.user!.id, friendshipId)
  res.json({ success: true, message: "Friend request accepted" })
})

// Also the cancel route: the recipient rejects, the sender cancels, and both
// are the same pending row being deleted by someone in the pair.
router.post("/request/:friendshipId/reject", async (req: Request, res: Response) => {
  const friendshipId = parseIntParam(String(req.params.friendshipId), "friendship ID")

  await rejectFriendRequest(req.user!.id, friendshipId)
  res.json({ success: true, message: "Friend request rejected" })
})

// NOTE the addressing: this one takes a USER uuid, while the accept/reject
// routes above take a FRIENDSHIP id. Two schemes in one router, kept because
// the app addresses an unfriend by the person, not by the row.
router.delete("/:friendId", async (req: Request, res: Response) => {
  const friend = await requireUser(req.params.friendId, "friend ID")

  await removeFriend(req.user!.id, friend.id)
  res.json({ success: true, message: "Friend removed" })
})

router.get("/blocked", async (req: Request, res: Response) => {
  const blocked = await getBlockedUsers(req.user!.id)
  res.json({ success: true, blocked })
})

/**
 * POST /api/friends/block/:userId
 *
 * Blocking also removes the friendship and every sharing permission between
 * the two accounts (see blockUser), so it is not reversible by unblocking:
 * the pair have to re-add each other afterwards.
 */
router.post("/block/:userId", async (req: Request, res: Response) => {
  const target = await requireUser(req.params.userId, "user ID")

  await blockUser(req.user!.id, target.id)
  res.json({ success: true, message: "User blocked" })
})

router.delete("/block/:userId", async (req: Request, res: Response) => {
  const target = await requireUser(req.params.userId, "user ID")

  if (!(await unblockUser(req.user!.id, target.id))) {
    throw new NotFoundError("Block")
  }
  res.json({ success: true, message: "User unblocked" })
})

/**
 * POST /api/friends/report
 *
 * Body: { userId, reason, details? }. Reports are stored for this instance's
 * operator to review (`bun run owngains reports`). A self-hosted deployment has
 * no central moderation team to forward them to.
 */
router.post("/report", async (req: Request, res: Response) => {
  const { userId, reason, details } = req.body

  if (!REPORT_REASONS.includes(reason)) {
    throw new ValidationError(
      `reason must be one of: ${REPORT_REASONS.join(", ")}`,
    )
  }

  if (details !== undefined && typeof details !== "string") {
    throw new ValidationError("details must be a string")
  }

  const target = await requireUser(userId, "user ID")

  const reportId = await reportUser(
    req.user!.id,
    target.id,
    reason as ReportReason,
    details,
  )

  res.status(201).json({
    success: true,
    message: "Report submitted",
    reportId,
  })
})

export default router
