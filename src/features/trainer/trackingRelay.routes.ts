// /api/sharing/tracking: the end-to-end encrypted Tracking Access relay.
// Every call is the caller acting on their own messages, never X-Trainee-Id.
import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "@/features/tracking/healthConsent.js"
import { AppError, ValidationError } from "@/middleware/errorHandler.js"
import { parseUuidParam, queryLimit, queryString } from "@/middleware/validation.js"
import {
  MAX_MESSAGE_CHARS,
  ackMessages,
  getPendingMessages,
  getRecipients,
  registerDeviceKey,
  requestResend,
  storeMessage,
  type MessageKind,
} from "./trackingRelay.model.js"
import { sendDemoTracking } from "./demoTracking.js"

const router: Router = Router()

router.use(authenticateToken, healthConsentGuard)

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function base64Field(body: Record<string, unknown>, name: string, length?: number): string {
  const v = body[name]
  if (typeof v !== "string" || !BASE64.test(v) || (length != null && v.length !== length))
    throw new ValidationError(`${name} must be ${length ? `${length} characters of ` : ""}base64`)
  return v
}

function deviceIdOf(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(v))
    throw new ValidationError("deviceId must be 8 to 64 letters, digits, _ or -")
  return v
}

router.put("/devices/key", async (req: Request, res: Response) => {
  const deviceId = deviceIdOf(req.body.deviceId)
  // 32 bytes of X25519 public key.
  const publicKey = base64Field(req.body, "publicKey", 44)
  const keyId = await registerDeviceKey(req.user!.id, deviceId, publicKey)
  await sendDemoTracking(req.user!.id)
  res.json({ success: true, data: { keyId } })
})

router.get("/recipients", async (req: Request, res: Response) => {
  const recipients = await getRecipients(req.user!.id)
  res.json({ success: true, data: { recipients } })
})

router.post("/messages", async (req: Request, res: Response) => {
  const { keyId, kind, ref = "" } = req.body
  if (!Number.isInteger(keyId) || keyId < 1) throw new ValidationError("keyId must be a positive integer")
  if (kind !== "snapshot" && kind !== "photo") throw new ValidationError("kind must be snapshot or photo")
  if (typeof ref !== "string" || ref.length > 64 || (kind === "photo" && !ref))
    throw new ValidationError("ref must be a string of at most 64 characters, required for a photo")
  const ciphertext = base64Field(req.body, "ciphertext")
  if (ciphertext.length > MAX_MESSAGE_CHARS)
    throw new AppError(
      `A message must not exceed ${MAX_MESSAGE_CHARS / 1024 / 1024} MB`,
      413,
      null,
      "PAYLOAD_TOO_LARGE",
    )
  await storeMessage(req.user!.id, {
    keyId,
    kind: kind as MessageKind,
    ref: kind === "snapshot" ? "" : ref,
    // 24-byte nonce, 32-byte ephemeral sender key.
    nonce: base64Field(req.body, "nonce", 32),
    senderKey: base64Field(req.body, "senderKey", 44),
    ciphertext,
  })
  res.status(201).json({ success: true })
})

router.get("/messages", async (req: Request, res: Response) => {
  const deviceId = deviceIdOf(queryString(req, "deviceId"))
  // Photos are up to 3 MB each, so pages stay small.
  const limit = queryLimit(req, { def: 5, max: 20 })
  const messages = await getPendingMessages(req.user!.id, deviceId, limit)
  res.json({ success: true, data: { messages } })
})

router.post("/messages/ack", async (req: Request, res: Response) => {
  const deviceId = deviceIdOf(req.body.deviceId)
  const { ids } = req.body
  if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => /^\d{1,19}$/.test(String(id))))
    throw new ValidationError("ids must be an array of at most 100 message ids")
  await ackMessages(req.user!.id, deviceId, ids.map(Number))
  res.json({ success: true })
})

router.post("/resend-requests", async (req: Request, res: Response) => {
  const deviceId = deviceIdOf(req.body.deviceId)
  const clientId = parseUuidParam(req.body.clientId, "clientId")
  await requestResend(req.user!.id, deviceId, clientId)
  res.json({ success: true })
})

export default router
