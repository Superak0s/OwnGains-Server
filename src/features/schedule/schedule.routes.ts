import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { applyTrainerContext, denyTrainer } from "@/middleware/trainerContext.js"
import { idempotent } from "@/middleware/idempotency.js"
import { ForbiddenError, NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import { parseIntParam, queryString } from "@/middleware/validation.js"
import {
  createScheduled,
  deleteScheduled,
  getScheduled,
  listScheduled,
  updateScheduled,
  type ScheduleFields,
  type ScheduledWorkout,
} from "./schedule.model.js"

const DAY_MS = 24 * 60 * 60 * 1000
/** Widest window one GET may ask for. */
const MAX_RANGE_DAYS = 400

const router: Router = Router()

router.use(authenticateToken, applyTrainerContext)

function parseDate(value: unknown, name: string): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN)
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${name} must be an ISO date`)
  return date
}

function wholeNumber(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new ValidationError(`${name} must be a whole number from ${min} to ${max}`)
  return value as number
}

/** Validates whichever writable fields the body carries. */
function readFields(body: Record<string, unknown>): Partial<ScheduleFields> {
  const fields: Partial<ScheduleFields> = {}
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : ""
    if (!title || title.length > 100) throw new ValidationError("title must be 1 to 100 characters")
    fields.title = title
  }
  if (body.programDay !== undefined)
    fields.programDay = body.programDay === null ? null : wholeNumber(body.programDay, "programDay", 1, 1000)
  if (body.startAt !== undefined) fields.startAt = parseDate(body.startAt, "startAt")
  if (body.durationMin !== undefined) fields.durationMin = wholeNumber(body.durationMin, "durationMin", 5, 600)
  if (body.reminderMinutes !== undefined)
    fields.reminderMinutes =
      body.reminderMinutes === null ? null : wholeNumber(body.reminderMinutes, "reminderMinutes", 0, 10080)
  if (body.alarm !== undefined) {
    if (typeof body.alarm !== "boolean") throw new ValidationError("alarm must be true or false")
    fields.alarm = body.alarm
  }
  return fields
}

/** Tells the other side of a trainer relationship to refetch. */
async function notify(req: Request, entry: ScheduledWorkout): Promise<void> {
  const { sendToUser } = await import("@/ws/wsServer.js")
  if (req.trainer) sendToUser(req.user!.uuid, "schedule_changed", {})
  else if (entry.scheduledBy) sendToUser(entry.scheduledBy.uuid, "schedule_changed", { clientUuid: req.user!.uuid })
}

router.get("/", async (req: Request, res: Response) => {
  const fromRaw = queryString(req, "from")
  const toRaw = queryString(req, "to")
  const from = fromRaw === undefined ? new Date(Date.now() - DAY_MS) : parseDate(fromRaw, "from")
  const to = toRaw === undefined ? new Date(from.getTime() + MAX_RANGE_DAYS * DAY_MS) : parseDate(toRaw, "to")
  if (to <= from) throw new ValidationError("to must be after from")
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS)
    throw new ValidationError(`The range can be at most ${MAX_RANGE_DAYS} days`)
  const includeCancelled = ["1", "true"].includes(queryString(req, "includeCancelled") ?? "")
  res.json({ success: true, scheduled: await listScheduled(req.user!.id, from, to, includeCancelled) })
})

router.post("/", idempotent, async (req: Request, res: Response) => {
  const fields = readFields(req.body ?? {})
  if (fields.title === undefined) throw new ValidationError("title is required")
  if (fields.startAt === undefined) throw new ValidationError("startAt is required")
  const entry = await createScheduled(
    req.user!.id,
    { programDay: null, durationMin: 60, reminderMinutes: null, alarm: false, ...fields } as ScheduleFields,
    req.trainer?.userId ?? null,
  )
  await notify(req, entry)
  res.status(201).json({ success: true, scheduled: entry })
})

router.patch("/:id", idempotent, async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "id")
  const current = await getScheduled(req.user!.id, id)
  if (current.cancelled) throw new NotFoundError("Scheduled workout")
  const body = (req.body ?? {}) as Record<string, unknown>
  const fields = readFields(body)
  const cancel = body.cancelled === true
  const accept = body.accepted === true

  let pending: boolean | undefined
  if (req.trainer) {
    // A trainer only suggests, so they change only their own suggestions and any change needs accepting again.
    if (current.trainerId !== req.trainer.userId)
      throw new ForbiddenError("Trainers can only change workouts they suggested", "NOT_YOUR_SUGGESTION")
    if (accept) throw new ForbiddenError("Only the client can accept a suggested workout", "NOT_YOUR_SUGGESTION")
    if (Object.keys(fields).length > 0) pending = true
  } else if (accept) {
    pending = false
  }

  await updateScheduled(req.user!.id, id, fields, { pending, cancel })
  const entry = await getScheduled(req.user!.id, id)
  await notify(req, entry)
  const { trainerId: _t, cancelled: _c, ...scheduled } = entry
  res.json({ success: true, scheduled })
})

router.delete("/:id", denyTrainer, async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "id")
  const entry = await getScheduled(req.user!.id, id)
  await deleteScheduled(req.user!.id, id)
  if (!entry.cancelled) await notify(req, entry)
  res.json({ success: true })
})

export default router
