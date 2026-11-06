import { Router, Request, Response } from "express"
import rateLimit from "express-rate-limit"
import jwt from "jsonwebtoken"
import { authenticateToken, requireAdmin } from "@/middleware/auth.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import { isUuid, parseIntParam, queryLimit } from "@/middleware/validation.js"
import { findUserForAuth } from "@/features/auth/auth.model.js"
import type { JwtPayload } from "@/features/auth/auth.types.js"
import { logger } from "@/utils/logger.js"
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  type FeedbackKind,
  type FeedbackStatus,
  deleteFeedback,
  insertFeedback,
  listFeedback,
  setFeedbackStatus,
} from "./feedback.model.js"

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !!process.env.VITEST,
  message: { success: false, error: "Too much feedback from this network, try again later" },
})

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value == null || value === "") return null
  if (typeof value !== "string" || value.trim().length > max)
    throw new ValidationError(`${name} must be a string of at most ${max} characters`)
  return value.trim() || null
}

// Sign-in is optional, and a token from another server must not fail the
// submission, so any verification failure just leaves the feedback anonymous.
async function signedInUserId(req: Request): Promise<number | null> {
  const token = /^Bearer +(\S+)$/.exec(req.headers["authorization"] ?? "")?.[1]
  if (!token) return null
  try {
    const { userId, tokenVersion } = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ["HS256"],
    }) as JwtPayload
    if (!isUuid(userId)) return null
    const found = await findUserForAuth(userId)
    return found && found.tokenVersion === tokenVersion ? found.user.id : null
  } catch {
    return null
  }
}

/** POST /api/feedback: anyone, signed in or not, can send the operator feedback. */
export const feedbackRoutes: Router = Router()

feedbackRoutes.post("/", submitLimiter, async (req: Request, res: Response) => {
  const body = req.body ?? {}
  if (!FEEDBACK_KINDS.includes(body.kind))
    throw new ValidationError(`kind must be one of ${FEEDBACK_KINDS.join(", ")}`)
  const message = optionalString(body.message, "message", 4000)
  if (!message) throw new ValidationError("message is required")
  await insertFeedback({
    kind: body.kind as FeedbackKind,
    message,
    contact: optionalString(body.contact, "contact", 200),
    appVersion: optionalString(body.appVersion, "appVersion", 32),
    platform: optionalString(body.platform, "platform", 16),
    osVersion: optionalString(body.osVersion, "osVersion", 32),
    userId: await signedInUserId(req),
  })
  res.status(201).json({ success: true })
})

function parseStatus(value: unknown): FeedbackStatus {
  if (!FEEDBACK_STATUSES.includes(value as FeedbackStatus))
    throw new ValidationError(`status must be one of ${FEEDBACK_STATUSES.join(", ")}`)
  return value as FeedbackStatus
}

/** /api/admin/feedback: the operator's inbox. */
export const adminFeedbackRoutes: Router = Router()

adminFeedbackRoutes.use(authenticateToken, requireAdmin)

adminFeedbackRoutes.get("/", async (req: Request, res: Response) => {
  const status = req.query.status ? parseStatus(req.query.status) : null
  const feedback = await listFeedback(status, queryLimit(req, { def: 200, max: 1000 }))
  logger.warn("[AUDIT] admin read feedback", { actor: req.user!.uuid, count: feedback.length })
  res.json({ success: true, feedback })
})

adminFeedbackRoutes.patch("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const id = parseIntParam(req.params.id, "feedback ID")
  if (!(await setFeedbackStatus(id, parseStatus(req.body?.status))))
    throw new NotFoundError("Feedback")
  res.json({ success: true })
})

adminFeedbackRoutes.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const id = parseIntParam(req.params.id, "feedback ID")
  if (!(await deleteFeedback(id))) throw new NotFoundError("Feedback")
  logger.warn("[AUDIT] admin delete feedback", { actor: req.user!.uuid, id })
  res.json({ success: true })
})
