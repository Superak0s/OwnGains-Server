import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import {
  ValidationError,
  NotFoundError,
} from "@/middleware/errorHandler.js"
import {
  logMacrosIntake,
  getMacrosHistory,
  deleteMacrosEntry,
} from "./macros.model.js"
import { idempotent } from "@/middleware/idempotency.js"

const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

function safeMacro(v: unknown, name: string): number | null {
  if (v == null) return null
  const n = parseFloat(v as string)
  if (isNaN(n) || !isFinite(n) || n < 0 || n > 9999) {
    throw new ValidationError(`Invalid ${name} value`)
  }
  return n
}

router.post("/log", idempotent, async (req: Request, res: Response) => {
  const {
    name,
    protein,
    carbs,
    fat,
    calories,
    errorMargin = 0,
    takenAt,
    note,
  } = req.body
  const userId = req.user!.id

  if (!takenAt) throw new ValidationError("takenAt is required")
  // Same guard as every other tracking timestamp: a phone whose clock is years
  // ahead would otherwise sort to the top of every history query forever.
  const parsedTakenAt = parseBackdatedTimestamp(takenAt, "takenAt")!

  const hasAtLeastOne =
    protein != null ||
    carbs != null ||
    fat != null ||
    calories != null ||
    name
  if (!hasAtLeastOne) {
    throw new ValidationError(
      "Provide at least a name or one macro value (protein, carbs, fat, calories)",
    )
  }

  const parsedProtein = safeMacro(protein, "protein")
  const parsedCarbs = safeMacro(carbs, "carbs")
  const parsedFat = safeMacro(fat, "fat")
  const parsedCalories = safeMacro(calories, "calories")
  const parsedMargin = safeMacro(errorMargin, "errorMargin") ?? 0

  const entry = await logMacrosIntake(
    userId,
    name,
    parsedProtein,
    parsedCarbs,
    parsedFat,
    parsedCalories,
    parsedMargin,
    parsedTakenAt,
    note,
  )

  // `entry` is the legacy key. See the note on the envelope in bodyStats.routes.ts.
  res.status(201).json({ success: true, data: entry, entry })
})

router.get("/log", async (req: Request, res: Response) => {
  const days = queryLimit(req, { def: 30, max: 365, key: "days" })
  const entries = await getMacrosHistory(req.user!.id, days)
  res.json({ success: true, data: entries, entries })
})

// Macro goals are stored in /api/settings with every other preference. There is no
// PUT /goals here any more.

router.delete("/log/:id", async (req: Request, res: Response) => {
  const entryId = parseIntParam(String(req.params.id), "macro entry ID")
  const deleted = await deleteMacrosEntry(req.user!.id, entryId)
  if (!deleted) throw new NotFoundError("Macro entry")
  res.json({ success: true })
})

export default router
