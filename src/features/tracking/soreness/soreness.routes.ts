// Soreness: log an episode, check in on it, watch it recover.
//
// This is the old /api/tracking/soreness and /api/tracking/doms as one router:
// they were two halves of the same thing pointed at two tables.

import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import { listFilter } from "../listFilter.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import {
  logSoreness,
  listSorenessEntries,
  getSorenessStats,
  batchFollowUp,
  deleteSorenessEntry,
} from "./soreness.model.js"
import { idempotent } from "@/middleware/idempotency.js"
import { requestTimeZone } from "@/utils/timeZone.js"

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
    requestTimeZone(req),
  )
  res.status(201).json({ success: true, data: entry })
})

/** GET /?muscle=<group>&status=active: both filters optional. */
router.get("/", async (req: Request, res: Response) => {
  const history = await listSorenessEntries(
    req.user!.id,
    listFilter(req),
    queryLimit(req, { def: 100, max: 365 }),
  )
  res.json({ success: true, data: history })
})

router.get("/stats", async (req: Request, res: Response) => {
  const days = queryLimit(req, { def: 30, max: 365, key: "days" })
  res.json({ success: true, data: await getSorenessStats(req.user!.id, days) })
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

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "soreness entry ID")
  if (!(await deleteSorenessEntry(req.user!.id, id)))
    throw new NotFoundError("Soreness entry")
  res.json({ success: true })
})

export default router
