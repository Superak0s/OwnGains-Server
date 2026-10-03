// One API for every scalar body metric, built-in or user-defined.
//
// This replaces /api/tracking/measurements (four hardcoded circumference
// columns) and /api/tracking/custom-measurements (a parallel set of endpoints
// for the user's own metrics). There is no difference between the two any more:
// a metric key is a metric key, and the only thing a definition adds is a label
// and a unit for keys the client doesn't already know.

import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import {
  logMetrics,
  getMetricHistory,
  getMetricGroups,
  deleteMeasurement,
  deleteMetricGroup,
  createMetricDefinition,
  getMetricDefinitions,
  requireKnownMetric,
  requireKnownMetrics,
  MAX_METRICS_PER_QUERY,
  MAX_VALUES_PER_ENTRY,
} from "./measurements.model.js"
import { idempotent } from "@/middleware/idempotency.js"

const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

/** `?metrics=waist_cm,chest_cm` → validated keys. */
async function parseMetrics(
  userId: number,
  raw: unknown,
  required: boolean,
): Promise<string[]> {
  const keys = String(raw ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
  if (keys.length === 0) {
    if (required) throw new ValidationError("metrics query parameter is required")
    return []
  }
  const unique = [...new Set(keys)]
  if (unique.length > MAX_METRICS_PER_QUERY)
    throw new ValidationError(
      `At most ${MAX_METRICS_PER_QUERY} metrics per request`,
    )
  await requireKnownMetrics(userId, unique)
  return unique
}

// ─── Definitions (static paths first) ─────────────────────────────────────────

router.post("/definitions", async (req: Request, res: Response) => {
  const { keyName, label, unit } = req.body
  const definition = await createMetricDefinition(
    req.user!.id,
    keyName,
    label,
    unit || null,
  )
  res.status(201).json({ success: true, data: definition })
})

router.get("/definitions", async (req: Request, res: Response) => {
  const definitions = await getMetricDefinitions(req.user!.id)
  res.json({ success: true, data: definitions })
})

// ─── Values ───────────────────────────────────────────────────────────────────

/**
 * POST { values: { waist_cm: 84, chest_cm: 102 }, measuredAt?, note? }
 *
 * Every value in one request shares one `measured_at`, which is what makes them
 * one measuring session: the unit the grouped read and the grouped delete work
 * in.
 */
router.post("/", idempotent, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { values, measuredAt, note } = req.body

  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new ValidationError("values must be an object of metric → number")

  const samples = Object.entries(values as Record<string, unknown>).map(
    ([metric, value]) => ({ metric, value: Number(value) }),
  )
  if (samples.length === 0)
    throw new ValidationError("At least one measurement is required")
  if (samples.length > MAX_VALUES_PER_ENTRY)
    throw new ValidationError(
      `At most ${MAX_VALUES_PER_ENTRY} measurements per entry`,
    )
  await requireKnownMetrics(userId, samples.map((s) => s.metric))

  const id = await logMetrics(
    userId,
    samples,
    parseBackdatedTimestamp(measuredAt, "measuredAt"),
    note || null,
  )
  res.status(201).json({ success: true, data: { id }, id })
})

/**
 * GET /?metrics=waist_cm,chest_cm: one entry per measuring session, each with
 * a `values` map of the requested metrics. A metric not recorded in a session
 * comes back null.
 */
router.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const metrics = await parseMetrics(userId, req.query.metrics, true)
  const limit = queryLimit(req, { def: 90, max: 365 })

  const rows = await getMetricGroups(
    userId,
    Object.fromEntries(metrics.map((m) => [m, m])),
    limit,
  )
  res.json({
    success: true,
    data: rows.map(({ id, measuredAt, note, ...values }) => ({
      id,
      measuredAt,
      note,
      values,
    })),
  })
})

/** GET /:metric/history: one metric as a plain series, for charts. */
router.get("/:metric/history", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const metric = String(req.params.metric)
  await requireKnownMetric(userId, metric)
  const limit = queryLimit(req, { def: 90, max: 365 })
  const entries = await getMetricHistory(userId, metric, limit)
  res.json({ success: true, data: entries })
})

/**
 * DELETE /:id removes that one measurement. `?metrics=a,b` widens it to the
 * whole measuring session (every listed metric recorded at the same instant),
 * which is what a client deleting a row of its measurements table wants, since
 * that row was several metrics to begin with.
 */
router.delete("/:id", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const id = parseIntParam(String(req.params.id), "measurement ID")
  const metrics = await parseMetrics(userId, req.query.metrics, false)

  const deleted = metrics.length
    ? await deleteMetricGroup(userId, id, metrics)
    : await deleteMeasurement(userId, id)
  if (!deleted) throw new NotFoundError("Measurement")
  res.json({ success: true })
})

export default router
