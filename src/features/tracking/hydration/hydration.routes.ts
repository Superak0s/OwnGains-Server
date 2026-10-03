// Hydration is a water_ml series in `measurements`: there is no hydration
// model file any more, and the daily goal / measurement-error setting moved to
// /api/settings with every other preference.

import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import { idempotent } from "@/middleware/idempotency.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import { NotFoundError } from "@/middleware/errorHandler.js"
import {
  METRICS,
  logMetrics,
  getMetricHistory,
  deleteMetricEntry,
} from "../measurements/measurements.model.js"

const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

// Every POST is a new drink: water_ml is additive, so two entries at the same
// timestamp are two rows (logMetrics never overwrites it). That makes a blind
// replay a duplicate, so an offline-queued drink is deduplicated the way
// session writes are: by Idempotency-Key.
router.post("/", idempotent, async (req: Request, res: Response) => {
  const { amountMl, measuredAt, note } = req.body
  // Range (> 0, at most 10 L) is checked in logMetrics, for every route
  // that writes water_ml.
  const id = await logMetrics(
    req.user!.id,
    [{ metric: METRICS.waterMl, value: amountMl }],
    parseBackdatedTimestamp(measuredAt, "measuredAt"),
    note || null,
  )
  res.status(201).json({ success: true, data: { id }, id })
})

router.get("/", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 100, max: 365 })
  const data = await getMetricHistory(req.user!.id, METRICS.waterMl, limit)
  res.json({ success: true, data })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "hydration entry ID")
  const deleted = await deleteMetricEntry(req.user!.id, id, METRICS.waterMl)
  if (!deleted) throw new NotFoundError("Hydration entry")
  res.json({ success: true })
})

export default router
