import { Router, Request, Response } from "express"
import rateLimit from "express-rate-limit"
import { authenticateToken } from "@/middleware/auth.js"
import { idempotent } from "@/middleware/idempotency.js"
import { ForbiddenError, ValidationError } from "@/middleware/errorHandler.js"
import { parseIntParam, parseUuidParam, queryLimit, queryString } from "@/middleware/validation.js"
import {
  deleteMessage,
  editMessage,
  listConversations,
  listMessages,
  markRead,
  resolvePeer,
  sendMessage,
} from "./messages.model.js"
import { sendPush } from "@/features/push/fcm.js"

/** Longest message body, matching the column. */
export const MAX_MESSAGE_LENGTH = 2000

/** The trimmed `body` of a send or edit, 1 to MAX_MESSAGE_LENGTH characters. */
function messageBody(req: Request): string {
  const { body: raw } = req.body ?? {}
  const body = typeof raw === "string" ? raw.trim() : ""
  if (!body) throw new ValidationError("body is required")
  if (body.length > MAX_MESSAGE_LENGTH)
    throw new ValidationError(`body must be at most ${MAX_MESSAGE_LENGTH} characters`)
  return body
}

const router: Router = Router()

// Never behind applyTrainerContext: a message is always sent as its author.
router.use(authenticateToken)

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `messages:${req.user!.id}`,
  skip: () => !!process.env.VITEST,
  message: { success: false, error: "Too many messages, please slow down" },
})

router.get("/", async (req: Request, res: Response) => {
  res.json({ success: true, conversations: await listConversations(req.user!.id) })
})

router.get("/:userUuid", async (req: Request, res: Response) => {
  const peer = await resolvePeer(req.user!.id, parseUuidParam(req.params.userUuid, "user id"))
  const beforeRaw = queryString(req, "before")
  const before = beforeRaw === undefined ? undefined : parseIntParam(beforeRaw, "before")
  const limit = queryLimit(req, { def: 50, max: 100 })
  res.json({
    success: true,
    canSend: peer.allowed,
    messages: await listMessages(req.user!.id, peer.id, before, limit),
  })
})

router.post("/:userUuid", sendLimiter, idempotent, async (req: Request, res: Response) => {
  const peer = await resolvePeer(req.user!.id, parseUuidParam(req.params.userUuid, "user id"))
  const body = messageBody(req)
  if (!peer.allowed)
    throw new ForbiddenError("You can only message friends and your trainer or clients", "NOT_ALLOWED")

  const message = await sendMessage(req.user!.id, peer.id, body)
  const { sendToUser } = await import("@/ws/wsServer.js")
  sendToUser(peer.uuid, "message_new", {
    fromUuid: req.user!.uuid,
    fromUsername: req.user!.username,
    message: { ...message, fromMe: false },
  })
  // Google relays the push, so it carries no text or name, only who to open.
  void sendPush(peer.id, {
    title: "New message",
    body: "You have a new message",
    channelId: "messages",
    tag: `message-${req.user!.uuid}`,
    data: { type: "message", fromUuid: req.user!.uuid },
  })
  res.status(201).json({ success: true, message })
})

router.post("/:userUuid/read", async (req: Request, res: Response) => {
  const peer = await resolvePeer(req.user!.id, parseUuidParam(req.params.userUuid, "user id"))
  if ((await markRead(req.user!.id, peer.id)) > 0) {
    const { sendToUser } = await import("@/ws/wsServer.js")
    sendToUser(peer.uuid, "message_read", { byUuid: req.user!.uuid, readAt: new Date().toISOString() })
  }
  res.json({ success: true })
})

router.patch("/:userUuid/:messageId", async (req: Request, res: Response) => {
  const peer = await resolvePeer(req.user!.id, parseUuidParam(req.params.userUuid, "user id"))
  const messageId = parseIntParam(String(req.params.messageId), "message ID")
  const message = await editMessage(req.user!.id, peer.id, messageId, messageBody(req))
  const { sendToUser } = await import("@/ws/wsServer.js")
  sendToUser(peer.uuid, "message_edited", { fromUuid: req.user!.uuid, message: { ...message, fromMe: false } })
  res.json({ success: true, message })
})

router.delete("/:userUuid/:messageId", async (req: Request, res: Response) => {
  const peer = await resolvePeer(req.user!.id, parseUuidParam(req.params.userUuid, "user id"))
  const messageId = parseIntParam(String(req.params.messageId), "message ID")
  await deleteMessage(req.user!.id, peer.id, messageId)
  const { sendToUser } = await import("@/ws/wsServer.js")
  sendToUser(peer.uuid, "message_deleted", { fromUuid: req.user!.uuid, messageId })
  res.json({ success: true })
})

export default router
