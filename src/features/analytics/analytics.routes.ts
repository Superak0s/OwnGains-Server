import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { applyTrainerContext } from "@/middleware/trainerContext.js"
import {
  parseIntParam,
  queryLimit,
  queryString,
} from "@/middleware/validation.js"
import { getAnalytics } from "./analytics.model.js"

const router: Router = Router()

router.get("/", authenticateToken, applyTrainerContext, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { dayNumber } = req.query
  // queryString, not a cast: ?split=a&split=b arrives as an array, which the
  // driver binds as the JSON text "[\"a\",\"b\"]" and matches no split at all,
  // so the dashboard came back all zeros instead of 400ing.
  const split = queryString(req, "split")

  const parsedDayNumber =
    dayNumber === undefined
      ? null
      : parseIntParam(String(dayNumber), "dayNumber")

  // The client picks its own lookback window. Without one this used to scan
  // the user's entire history on every dashboard open. 365 covers the default
  // dashboard and older app builds that send no ?days=. Ceiling is 10 years,
  // which is "all time" for any real user. The volume sum reads
  // idx_ws_workout_volume (workout_id, weight, reps) as a covering index, but a
  // wider window is still more rows summed per dashboard open.
  const days = queryLimit(req, { def: 365, max: 3650, key: "days" })

  const analytics = await getAnalytics(
    userId,
    split || null,
    parsedDayNumber,
    days,
  )

  res.json({
    success: true,
    totalSessions: analytics.total_sessions || 0,
    totalSetsCompleted: analytics.total_sets || 0,
    totalVolume: Math.round(analytics.total_volume || 0),
    firstSession: analytics.first_session,
    lastSession: analytics.last_session,
  })
})

export default router
