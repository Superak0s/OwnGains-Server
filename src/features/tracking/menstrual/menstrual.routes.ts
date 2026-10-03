import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import {
  logMenstrualCycle,
  getMenstrualHistory,
  getCycleStats,
  updateMenstrualCycle,
  deleteMenstrualEntry,
} from "./menstrual.model.js"
import { idempotent } from "@/middleware/idempotency.js"

const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

router.post("/", idempotent, async (req: Request, res: Response) => {
  const { cycleStart, symptoms } = req.body
  if (!cycleStart) throw new ValidationError("Cycle start date is required")
  // A future cycle_start becomes the "last" cycle and makes every phase
  // estimate nonsense, so a typo'd year is rejected like every other
  // backdated tracking timestamp.
  const entry = await logMenstrualCycle(
    req.user!.id,
    parseBackdatedTimestamp(cycleStart, "cycleStart")!,
    symptoms,
  )
  res.status(201).json({ success: true, data: entry })
})

router.get("/", async (req: Request, res: Response) => {
  const history = await getMenstrualHistory(
    req.user!.id,
    queryLimit(req, { def: 12, max: 100 }),
  )
  res.json({ success: true, data: history })
})

/**
 * ?periodDays / ?cycleLengthDays preview the stats under lengths the user is
 * editing but hasn't saved to /api/settings yet. Absent means "use the saved
 * ones". Present but malformed is a client bug, not a silent fallback.
 */
router.get("/stats", async (req: Request, res: Response) => {
  const optionalDays = (raw: unknown, field: string): number | undefined => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1)
      throw new ValidationError(`${field} must be a positive integer`)
    return n
  }

  const data = await getCycleStats(req.user!.id, {
    periodDays: optionalDays(req.query.periodDays, "periodDays"),
    cycleLengthDays: optionalDays(req.query.cycleLengthDays, "cycleLengthDays"),
  })
  res.json({ success: true, data })
})

/** The period ends and the symptom list grows after the cycle is logged. */
router.patch("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "menstrual entry ID")
  const { cycleEnd, symptoms } = req.body
  const entry = await updateMenstrualCycle(req.user!.id, id, {
    cycleEnd,
    symptoms,
  })
  res.json({ success: true, data: entry })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "menstrual entry ID")
  if (!(await deleteMenstrualEntry(req.user!.id, id)))
    throw new NotFoundError("Menstrual entry")
  res.json({ success: true })
})

// Period/cycle length preferences live in GET/PATCH /api/settings now, with
// every other preference. There are no /settings routes here any more.

export default router
