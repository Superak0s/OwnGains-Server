import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import { healthConsentGuard } from "@/features/tracking/healthConsent.js"
import {
  getUserSettings,
  updateUserSettings,
  SETTING_KEYS,
  INTEGER_SETTING_KEYS,
  type SettingKey,
} from "./settings.model.js"

const router: Router = Router()

router.use(authenticateToken, healthConsentGuard)

router.get("/", async (req: Request, res: Response) => {
  const settings = await getUserSettings(req.user!.id)
  res.json({ success: true, data: settings })
})

/**
 * PATCH with any subset of the setting keys. Anything not sent keeps its current
 * value, so the hydration screen and the macros screen can each write only what
 * they own without reading the whole object first.
 */
router.patch("/", async (req: Request, res: Response) => {
  const patch: Partial<Record<SettingKey, number>> = {}

  // A key this server doesn't know was previously dropped in silence, so
  // `{"hydrationGoalMI": 3000}` (capital i) returned 200 with nothing changed
  // and the client believed it had saved.
  const unknown = Object.keys(req.body).filter(
    (k) => !(SETTING_KEYS as string[]).includes(k),
  )
  if (unknown.length > 0)
    throw new ValidationError(
      `Unknown setting(s): ${unknown.join(", ")}. Known settings: ${SETTING_KEYS.join(", ")}`,
    )

  for (const key of SETTING_KEYS) {
    const value = req.body[key]
    if (value == null) continue
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new ValidationError(`${key} must be a number >= 0`)
    // The column is an integer type, so MySQL would round instead of refusing.
    if (INTEGER_SETTING_KEYS.has(key) && !Number.isInteger(value))
      throw new ValidationError(`${key} must be a whole number`)
    patch[key] = value
  }

  // The CHECK constraints in schema.sql are the real range rules. This only
  // rejects a body that would have changed nothing.
  if (Object.keys(patch).length === 0)
    throw new ValidationError("No known settings in request body")

  await updateUserSettings(req.user!.id, patch)
  const settings = await getUserSettings(req.user!.id)
  res.json({ success: true, data: settings })
})

export default router
