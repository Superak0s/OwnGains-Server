import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import {
  parseIntParam,
  queryLimit,
  parseBackdatedTimestamp,
  requireOptionalNote,
} from "@/middleware/validation.js"
import {
  ValidationError,
  NotFoundError,
} from "@/middleware/errorHandler.js"
import {
  createSupplement,
  getSupplementById,
  listSupplementSummaries,
  updateSupplement,
  deleteSupplement,
  logSupplement,
  hasTakenTodayServer,
  getHistory,
  getStreak,
  deleteLogEntry,
} from "./supplements.model.js"
import { idempotent } from "@/middleware/idempotency.js"

const router: Router = Router()
router.use(authenticateToken)
router.use(healthConsentGuard)

const VALID_TIME = /^\d{1,2}:\d{2}$/
const VALID_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

const isIntIn = (v: unknown, min: number, max: number): boolean =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max

function validateSupplementFields(
  fields: Record<string, unknown>,
  requireName: boolean,
): void {
  const {
    name,
    unit,
    defaultAmount,
    dosesPerDay,
    doseIntervalMinutes,
    reminderTime,
    color,
  } = fields
  if (requireName || name !== undefined) {
    if (typeof name !== "string" || !name.trim())
      throw new ValidationError("name must be a non-empty string")
    if (name.trim().length > 100)
      throw new ValidationError("name must be 100 characters or fewer")
  }
  if (
    unit !== undefined &&
    (typeof unit !== "string" || !unit.trim() || unit.length > 30)
  ) {
    throw new ValidationError("unit must be a non-empty string (max 30 chars)")
  }
  if (
    defaultAmount !== undefined &&
    (typeof defaultAmount !== "number" ||
      defaultAmount <= 0 ||
      defaultAmount > 10000)
  ) {
    throw new ValidationError(
      "defaultAmount must be a positive number (max 10000)",
    )
  }
  if (dosesPerDay !== undefined && !isIntIn(dosesPerDay, 1, 10)) {
    throw new ValidationError("dosesPerDay must be an integer between 1 and 10")
  }
  if (doseIntervalMinutes != null && !isIntIn(doseIntervalMinutes, 1, 1440)) {
    throw new ValidationError(
      "doseIntervalMinutes must be an integer between 1 and 1440, or null",
    )
  }
  if (
    reminderTime != null &&
    (typeof reminderTime !== "string" || !VALID_TIME.test(reminderTime))
  ) {
    throw new ValidationError("reminderTime must be in HH:MM format")
  }
  if (
    color != null &&
    (typeof color !== "string" || !VALID_HEX_COLOR.test(color))
  ) {
    throw new ValidationError("color must be a hex color string (e.g. #FF5733)")
  }
}

async function requireSupplement(userId: number, supplementId: number) {
  const s = await getSupplementById(userId, supplementId)
  if (!s) throw new NotFoundError("Supplement")
  return s
}

router.get("/", async (req: Request, res: Response) => {
  const summaries = await listSupplementSummaries(req.user!.id)
  res.json({ success: true, data: summaries, supplements: summaries })
})

router.post("/", async (req: Request, res: Response) => {
  const {
    name,
    unit = "g",
    defaultAmount,
    reminderEnabled = false,
    reminderTime = null,
    color = null,
    icon = null,
    dosesPerDay = 1,
    doseIntervalMinutes = null,
  } = req.body

  validateSupplementFields(
    { name, unit, defaultAmount, dosesPerDay, doseIntervalMinutes, reminderTime, color },
    true,
  )

  const supplementId = await createSupplement(
    req.user!.id,
    name.trim(),
    unit.trim(),
    defaultAmount ?? 5,
    reminderEnabled,
    reminderTime,
    color,
    icon ?? null,
    dosesPerDay,
    doseIntervalMinutes,
  )
  const [summary] = await listSupplementSummaries(req.user!.id, supplementId)

  res.status(201).json({ success: true, data: summary, supplement: summary })
})

router.patch("/:id", async (req: Request, res: Response) => {
  const supplementId = parseIntParam(String(req.params.id), "supplement ID")
  await requireSupplement(req.user!.id, supplementId)

  const {
    name,
    unit,
    defaultAmount,
    reminderEnabled,
    reminderTime,
    color,
    icon,
    dosesPerDay,
    doseIntervalMinutes,
  } = req.body

  validateSupplementFields(
    { name, unit, defaultAmount, dosesPerDay, doseIntervalMinutes, reminderTime, color },
    false,
  )

  await updateSupplement(req.user!.id, supplementId, {
    name: name?.trim(),
    unit: unit?.trim(),
    defaultAmount,
    dosesPerDay,
    doseIntervalMinutes,
    reminderEnabled,
    reminderTime,
    color,
    icon,
  })
  const [updated] = await listSupplementSummaries(req.user!.id, supplementId)

  res.json({ success: true, data: updated, supplement: updated })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const supplementId = parseIntParam(String(req.params.id), "supplement ID")
  const deleted = await deleteSupplement(req.user!.id, supplementId)
  if (!deleted) throw new NotFoundError("Supplement")
  res.json({ success: true })
})

router.post("/:id/log", idempotent, async (req: Request, res: Response) => {
  const supplementId = parseIntParam(String(req.params.id), "supplement ID")
  const supplement = await requireSupplement(req.user!.id, supplementId)
  const { amount, takenAt, note } = req.body

  if (
    amount !== undefined &&
    (typeof amount !== "number" || amount <= 0 || amount > 10000)
  ) {
    throw new ValidationError("amount must be a positive number (max 10000)")
  }

  const entryId = await logSupplement(
    req.user!.id,
    supplementId,
    amount ?? supplement.defaultAmount,
    // A future takenAt silently zeroes the streak (see streakFromDays), so it
    // is rejected here rather than quietly destroying the user's history.
    parseBackdatedTimestamp(takenAt, "takenAt"),
    requireOptionalNote(note) ?? null,
  )
  const streak = await getStreak(req.user!.id, supplementId)

  res
    .status(201)
    .json({ success: true, data: { id: entryId, streak }, id: entryId, streak })
})

router.get("/:id/log", async (req: Request, res: Response) => {
  const supplementId = parseIntParam(String(req.params.id), "supplement ID")
  await requireSupplement(req.user!.id, supplementId)

  const limit = queryLimit(req, { def: 30, max: 365 })
  // Sequential: three small reads shouldn't take three pool connections at once.
  const entries = await getHistory(req.user!.id, supplementId, limit)
  const streak = await getStreak(req.user!.id, supplementId)
  const todayEntry = await hasTakenTodayServer(req.user!.id, supplementId)

  const log = { entries, streak, takenToday: !!todayEntry, todayEntry }
  res.json({ success: true, data: log, ...log })
})

router.delete("/:id/log/:entryId", async (req: Request, res: Response) => {
  const supplementId = parseIntParam(String(req.params.id), "supplement ID")
  await requireSupplement(req.user!.id, supplementId)

  const entryId = parseIntParam(String(req.params.entryId), "entry ID")

  const deleted = await deleteLogEntry(req.user!.id, supplementId, entryId)
  if (!deleted) throw new NotFoundError("Log entry")
  res.json({ success: true })
})

export default router
