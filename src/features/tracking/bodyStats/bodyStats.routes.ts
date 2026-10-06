import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import {
  ValidationError,
  NotFoundError,
} from "@/middleware/errorHandler.js"
import {
  validateWeightEntry,
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import { logger } from "@/utils/logger.js"
import {
  METRICS,
  logMetrics,
  getMetricHistory,
  getLatestMetric,
  deleteMetricEntry,
} from "../measurements/measurements.model.js"
import {
  calculateBodyFatPercentage,
  logBodyFat,
  getBodyFatHistory,
  deleteBodyFatEntry,
} from "./bodyStats.model.js"
import { getUserBodyData } from "@/features/auth/user.model.js"

// Every response here is `{ success, data }`. The older per-feature keys
// (`entry`, `entries`, `id`, `supplement`, `supplements`) are still emitted
// beside `data` so an app build released after the server image still works.
// Drop them once no released app reads them.
const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

router.post("/weight", validateWeightEntry, async (req: Request, res: Response) => {
  const { weightKg, measuredAt, note } = req.body
  const id = await logMetrics(
    req.user!.id,
    [{ metric: METRICS.weightKg, value: weightKg }],
    parseBackdatedTimestamp(measuredAt, "measuredAt"),
    note || null,
  )
  res.status(201).json({ success: true, data: { id }, id })
})

router.get("/weight/current", async (req: Request, res: Response) => {
  const entry = await getLatestMetric(req.user!.id, METRICS.weightKg)
  res.json({ success: true, data: entry, entry })
})

router.get("/weight", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 90, max: 365 })
  const entries = await getMetricHistory(req.user!.id, METRICS.weightKg, limit)
  res.json({ success: true, data: entries, entries })
})

router.delete("/weight/:id", async (req: Request, res: Response) => {
  const entryId = parseIntParam(String(req.params.id), "weight entry ID")
  const deleted = await deleteMetricEntry(req.user!.id, entryId, METRICS.weightKg)
  if (!deleted) throw new NotFoundError("Weight entry")
  res.json({ success: true })
})

/**
 * The tape measurements behind a body-fat log, in cm, checked against the
 * formula when the profile has a height.
 */
async function checkTapeMeasurements(
  userId: number,
  measurements: { waist?: number; neck?: number; hip?: number; unit?: string },
  bfFormulaSex: "male" | "female" | undefined,
  percentage: number,
): Promise<{ waistCm: number; neckCm: number; hipCm: number | null }> {
  const { waist, neck, hip, unit } = measurements

  // The client only sends bfFormulaSex when it differs from the stored one, so
  // fall back to the profile: the formula picks a different branch per sex.
  const userData = await getUserBodyData(userId)
  const sex: "male" | "female" = bfFormulaSex ?? userData.bfFormulaSex

  if (!waist || waist <= 0)
    throw new ValidationError("Invalid waist measurement")
  if (!neck || neck <= 0)
    throw new ValidationError("Invalid neck measurement")
  if (sex === "female" && (!hip || hip <= 0)) {
    throw new ValidationError(
      "Invalid hip measurement (required for females)",
    )
  }

  const toCm = unit === "in" ? 2.54 : 1
  const w: number = waist * toCm
  const n: number = neck * toCm
  const hipCm = hip ? hip * toCm : null

  if (w <= n) {
    throw new ValidationError(
      "Waist measurement must be greater than neck measurement",
    )
  }

  // Height is only used to re-derive the percentage as a cross-check: the
  // client already did the maths with its own copy, and the height is no longer
  // copied onto the entry (it is read live from the profile). A profile without
  // a height skips the check instead of rejecting the log.
  if (userData.heightCm) {
    const calculatedPercentage = calculateBodyFatPercentage(
      sex,
      userData.heightCm,
      w,
      n,
      hipCm,
    )

    if (Math.abs(calculatedPercentage - percentage) > 0.5) {
      logger.warn("Body fat calculation mismatch (values not logged: health data)")
    }
  }
  return { waistCm: w, neckCm: n, hipCm }
}

router.post("/bodyfat/log", async (req: Request, res: Response) => {
  const { percentage, measurements, measuredAt, bfFormulaSex } = req.body
  const userId = req.user!.id

  if (percentage == null) throw new ValidationError("percentage is required")

  // Validate percentage BEFORE any DB calls. 0 is rejected too: ck_m_value
  // only stores value > 0, so 0% would be a 500 on insert.
  if (typeof percentage !== "number" || percentage <= 0 || percentage > 100) {
    throw new ValidationError(
      `Invalid body fat percentage: ${percentage}%. Must be between 1-100%.`,
    )
  }

  // An override the client sends must name a real sex, otherwise it falls
  // silently into the wrong formula branch.
  if (bfFormulaSex != null && bfFormulaSex !== "male" && bfFormulaSex !== "female")
    throw new ValidationError("bfFormulaSex must be 'male' or 'female'")

  // Health Connect readings carry only a percentage: no tape measurements, so
  // no circumferences to store and no formula to cross-check.
  const { waistCm, neckCm, hipCm } =
    measurements == null
      ? { waistCm: null, neckCm: null, hipCm: null }
      : await checkTapeMeasurements(userId, measurements, bfFormulaSex, percentage)

  const entry = await logBodyFat(
    userId,
    percentage,
    waistCm,
    neckCm,
    hipCm,
    parseBackdatedTimestamp(measuredAt, "measuredAt") ?? new Date().toISOString(),
  )

  res.status(201).json({ success: true, data: entry, entry })
})

router.get("/bodyfat/log", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 90, max: 365 })
  const entries = await getBodyFatHistory(req.user!.id, limit)
  res.json({ success: true, data: entries, entries })
})

router.delete("/bodyfat/log/:id", async (req: Request, res: Response) => {
  const entryId = parseIntParam(String(req.params.id), "body fat entry ID")
  const deleted = await deleteBodyFatEntry(req.user!.id, entryId)
  if (!deleted) throw new NotFoundError("Body fat entry")
  res.json({ success: true })
})

export default router
