// Soreness: log an episode, check in on it, watch it recover.
//
// This is the old /api/tracking/soreness and /api/tracking/doms as one router:
// they were two halves of the same thing pointed at two tables.

import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
  listMuscleFilter,
  listActiveFilter,
} from "@/middleware/validation.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import {
  logSoreness,
  listSorenessEntries,
  MAX_ACTIVE_EPISODES,
  type SorenessFilter,
  getSorenessStats,
  addFollowUp,
  batchFollowUp,
  deleteSorenessEntry,
} from "./soreness.model.js"
import { idempotent } from "@/middleware/idempotency.js"

const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

router.post("/", idempotent, async (req: Request, res: Response) => {
  const { muscleGroup, intensity, loggedAt, note } = req.body
  const entry = await logSoreness(
    req.user!.id,
    muscleGroup,
    intensity,
    parseBackdatedTimestamp(loggedAt, "loggedAt"),
    note ?? null,
  )
  res.status(201).json({ success: true, data: entry })
})

/** ?muscle= and ?status=active, shared by the list routes below. */
function sorenessFilter(req: Request): SorenessFilter {
  return { muscle: listMuscleFilter(req), activeOnly: listActiveFilter(req) }
}

/**
 * GET /?muscle=<group>&status=active: both filters optional. /active and
 * /muscle/:muscle below are the same list with one filter fixed, kept for
 * app builds that call them.
 */
router.get("/", async (req: Request, res: Response) => {
  const history = await listSorenessEntries(
    req.user!.id,
    sorenessFilter(req),
    queryLimit(req, { def: 100, max: 365 }),
  )
  res.json({ success: true, data: history })
})

// Static paths before the dynamic /:id ones.

router.get("/active", async (req: Request, res: Response) => {
  const entries = await listSorenessEntries(
    req.user!.id,
    { ...sorenessFilter(req), activeOnly: true },
    queryLimit(req, { def: MAX_ACTIVE_EPISODES, max: MAX_ACTIVE_EPISODES }),
  )
  res.json({ success: true, data: entries })
})

router.get("/stats", async (req: Request, res: Response) => {
  const days = queryLimit(req, { def: 30, max: 365, key: "days" })
  res.json({ success: true, data: await getSorenessStats(req.user!.id, days) })
})

router.get("/muscle/:muscle", async (req: Request, res: Response) => {
  const entries = await listSorenessEntries(
    req.user!.id,
    { ...sorenessFilter(req), muscle: String(req.params.muscle) },
    queryLimit(req, { def: 100, max: 365 }),
  )
  res.json({ success: true, data: entries })
})

/** Check in on many episodes at once: the "how is everything today" screen. */
router.post("/follow-ups", idempotent, async (req: Request, res: Response) => {
  const { updates } = req.body
  if (!Array.isArray(updates))
    throw new ValidationError("updates must be an array")
  // The ids go straight into a bind list, so they get parsed here rather than
  // reaching mysql2 as undefined.
  const { entries, skipped } = await batchFollowUp(
    req.user!.id,
    updates.map((u) => ({
      ...u,
      sorenessId: parseIntParam(String(u?.sorenessId), "soreness entry ID"),
    })),
  )
  res.json({ success: true, data: entries, skipped })
})

/** Check in on one episode. The episode's own status follows the report. */
router.post("/:id/follow-ups", idempotent, async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "soreness entry ID")
  const { intensity, status, note } = req.body
  // note passes raw: absent leaves the episode note alone, null clears it
  const entry = await addFollowUp(req.user!.id, id, intensity, status, note)
  res.status(201).json({ success: true, data: entry })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "soreness entry ID")
  if (!(await deleteSorenessEntry(req.user!.id, id)))
    throw new NotFoundError("Soreness entry")
  res.json({ success: true })
})

export default router
