import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import { ValidationError, NotFoundError } from "@/middleware/errorHandler.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
  listMuscleFilter,
  listActiveFilter,
} from "@/middleware/validation.js"
import {
  logInjury,
  listInjuries,
  updateInjury,
  deleteInjury,
  type InjuryFilter,
} from "./injury.model.js"
import { idempotent } from "@/middleware/idempotency.js"

const router: Router = Router()

/** Injury lists were unbounded. A client that wants more asks with ?limit=. */
const LIST_LIMIT = (req: Request) => queryLimit(req, { def: 100, max: 500 })

router.use(authenticateToken)
router.use(healthConsentGuard)

/** ?muscle= and ?status=active, shared by every list route below. */
function injuryFilter(req: Request): InjuryFilter {
  return {
    muscle: listMuscleFilter(req),
    activeOnly: listActiveFilter(req),
  }
}

router.post("/", idempotent, async (req: Request, res: Response) => {
  const { muscleGroup, injuryType, painLevel, startDate, note } = req.body

  if (!muscleGroup || !injuryType || painLevel === undefined || painLevel === null) {
    throw new ValidationError("Muscle group, injury type, and pain level are required")
  }

  const result = await logInjury(
    req.user!.id,
    muscleGroup,
    injuryType,
    painLevel,
    parseBackdatedTimestamp(startDate || null, "startDate") ??
      new Date().toISOString(),
    note || null,
  )
  res.status(201).json({ success: true, data: result })
})

/**
 * GET /?muscle=<group>&status=active: both filters optional. /active and
 * /muscle/:muscle below are the same list with one filter fixed, kept for
 * app builds that call them.
 */
router.get("/", async (req: Request, res: Response) => {
  const injuries = await listInjuries(req.user!.id, injuryFilter(req), LIST_LIMIT(req))
  res.json({ success: true, data: injuries })
})

// Static paths before the dynamic /:id routes.
router.get("/active", async (req: Request, res: Response) => {
  const injuries = await listInjuries(
    req.user!.id,
    { ...injuryFilter(req), activeOnly: true },
    LIST_LIMIT(req),
  )
  res.json({ success: true, data: injuries })
})

router.get("/muscle/:muscle", async (req: Request, res: Response) => {
  const injuries = await listInjuries(
    req.user!.id,
    { ...injuryFilter(req), muscle: String(req.params.muscle) },
    LIST_LIMIT(req),
  )
  res.json({ success: true, data: injuries })
})

/** An injury changes as it heals: pain level, status, recovery date, note. */
router.patch("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "injury ID")
  const { painLevel, status, recoveryDate, note } = req.body
  const injury = await updateInjury(req.user!.id, id, {
    painLevel,
    status,
    recoveryDate,
    note,
  })
  res.json({ success: true, data: injury })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "injury ID")
  if (!(await deleteInjury(req.user!.id, id))) throw new NotFoundError("Injury")
  res.json({ success: true })
})

export default router
