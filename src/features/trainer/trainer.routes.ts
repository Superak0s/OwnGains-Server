// /api/trainer: a trainer's client list and the requests that create clients.
// Acting as a client is still X-Trainee-Id on the sessions, program and
// analytics routers (middleware/trainerContext.ts), not anything here.
import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "@/features/tracking/healthConsent.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import { parseIntParam, parseUuidParam, queryString } from "@/middleware/validation.js"
import {
  acceptTrainerRequest,
  cancelTrainerRequest,
  createTrainerRequest,
  getClients,
  listTrainerRequests,
  rejectTrainerRequest,
  removeClient,
} from "./trainer.model.js"

const router: Router = Router()

router.use(authenticateToken, healthConsentGuard)

const isDate = (s: string | undefined): s is string =>
  !!s &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  // Round-trips only for a real calendar day, so 2026-02-31 is refused.
  new Date(`${s}T00:00:00Z`).toISOString().startsWith(s)

function requireIncludeTracking(body: Record<string, unknown>): boolean {
  if (typeof body?.includeTracking !== "boolean")
    throw new ValidationError("includeTracking must be a boolean")
  return body.includeTracking
}

router.get("/clients", async (req: Request, res: Response) => {
  const weekStart = queryString(req, "weekStart")
  if (!isDate(weekStart)) throw new ValidationError("weekStart must be YYYY-MM-DD")
  const clients = await getClients(req.user!.id, weekStart)
  res.json({ success: true, data: { clients } })
})

router.post("/requests", async (req: Request, res: Response) => {
  const { toUsername, toUserId } = req.body ?? {}
  const includeTracking = requireIncludeTracking(req.body)
  let target: { username: string } | { uuid: string }
  if (typeof toUsername === "string" && toUsername) target = { username: toUsername }
  else if (toUserId != null) target = { uuid: parseUuidParam(toUserId, "toUserId") }
  else throw new ValidationError("toUsername or toUserId is required")

  const request = await createTrainerRequest(req.user!.id, target, includeTracking)
  res.status(201).json({ success: true, data: { request } })
})

router.get("/requests/received", async (req: Request, res: Response) => {
  const requests = await listTrainerRequests(req.user!.id, "received")
  res.json({ success: true, data: { requests } })
})

router.get("/requests/sent", async (req: Request, res: Response) => {
  const requests = await listTrainerRequests(req.user!.id, "sent")
  res.json({ success: true, data: { requests } })
})

router.post("/requests/:id/accept", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "request ID")
  await acceptTrainerRequest(req.user!.id, id, requireIncludeTracking(req.body))
  res.json({ success: true })
})

router.post("/requests/:id/reject", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "request ID")
  await rejectTrainerRequest(req.user!.id, id)
  res.json({ success: true })
})

router.delete("/requests/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "request ID")
  await cancelTrainerRequest(req.user!.id, id)
  res.json({ success: true })
})

router.delete("/clients/:userId", async (req: Request, res: Response) => {
  await removeClient(req.user!.id, parseUuidParam(req.params.userId, "userId"))
  res.json({ success: true })
})

export default router
