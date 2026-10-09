import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "@/features/tracking/healthConsent.js"
import { applyTrainerContext, denyTrainer } from "@/middleware/trainerContext.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import { idempotent } from "@/middleware/idempotency.js"
import {
  parseBackdatedTimestamp,
  parseIntParam,
  queryLimit,
  queryString,
  validateRequired,
  validateDemoFill,
  validateSessionCreation,
  validateSetTiming,
} from "@/middleware/validation.js"
import { logger } from "@/utils/logger.js"
import { envInt } from "@/config/env.js"
import { sendToUser, hasOtherClients } from "@/ws/wsServer.js"
import {
  createSession,
  recordSetTiming,
  updateSetTiming,
  deleteSetByIndex,
  renameExerciseInHistory,
  endSession,
  updateSessionDay,
  getSessionDetails,
  getSessionHistory,
  historyCursor,
  parseHistoryCursor,
  getRecordSessions,
  deleteAllSessionsForSplit,
} from "./workouts.model.js"
import { clearDemoData, fillDemoData } from "./demo.model.js"
import { getLiveAudience } from "../social/sharing/sharing.model.js"
import { pushWatchProgress } from "../social/sharing/sharing.watch.routes.js"

const router: Router = Router()

/**
 * Page size ceiling for GET /api/sessions?includeTimings=true. The app follows
 * `nextCursor`, so 100 is enough. Read per request so a test can change it.
 */
const historyTimingsMax = () => envInt("HISTORY_TIMINGS_MAX", 100, 1)

router.use(authenticateToken, applyTrainerContext, healthConsentGuard)

router.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { dayNumber, includeTimings } = req.query
  const split = queryString(req, "split")

  // With timings, a page is capped at HISTORY_TIMINGS_MAX sessions: ?limit=1000
  // is a ~36k-row, double-digit-MB response serialised and gzipped on the event
  // loop, and repeatable at the /api rate limit. Full history is reached by
  // paging instead (`?before=<nextCursor>`).
  const withTimings = includeTimings === "true"
  const limit = queryLimit(req, {
    def: 30,
    max: withTimings ? historyTimingsMax() : 365,
  })

  const rawBefore = queryString(req, "before")
  const before = rawBefore ? parseHistoryCursor(rawBefore) : null
  if (rawBefore && !before)
    throw new ValidationError("before must be a nextCursor from a previous page")

  const sessions = await getSessionHistory(
    userId,
    split || null,
    dayNumber ? parseIntParam(String(dayNumber), "dayNumber") : null,
    limit,
    withTimings,
    before,
  )

  // No `total`: it was sessions.length, which a client can read off the array
  // itself, and it read like a full-history count that it never was.
  // nextCursor (added, older clients ignore it) is null on the last page.
  const last = sessions.at(-1)
  res.json({
    success: true,
    sessions,
    nextCursor: sessions.length === limit && last ? historyCursor(last) : null,
  })
})

/**
 * GET /api/sessions/exercise-records
 *
 * Every session holding an all-time record set, trimmed to those sets (see
 * getRecordSessions). Read-only, so a trainer gets the trainee's records like
 * any other GET here. Static path: must remain above GET /:sessionId, which
 * would otherwise answer it with a 400.
 */
router.get("/exercise-records", async (req: Request, res: Response) => {
  const sessions = await getRecordSessions(req.user!.id)
  res.json({ success: true, sessions })
})

router.post("/start", idempotent, validateSessionCreation, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { dayNumber, dayTitle } = req.body

  // primaryMuscles/secondaryMuscles in the body are ignored: a workout's muscle
  // labels are read through its program_day_id so that editing a program day
  // relabels its history instead of leaving stale copies on every workout row.
  const newSessionId: number = await createSession(
    userId,
    dayNumber,
    dayTitle,
    req.body.startTime || null,
    req.body.isDemo === true,
    req.body.split || null,
  )

  const session = await getSessionDetails(newSessionId, userId)

  pushSessionStatusToWatchers(
    req.user!,
    newSessionId,
    "friend_session_started",
  )

  if (req.trainer)
    pushTrainerEvent(req, newSessionId, "trainer_session_started")

  res.json({ success: true, session: { ...session, id: newSessionId } })
})

/**
 * POST /api/sessions/rename-exercise
 *
 * Rename / re-group an exercise everywhere it appears in a split's session
 * history. Static path, declared before the dynamic /:sessionId routes.
 */
// validateSetTiming is mounted for its primaryMuscles/secondaryMuscles checks
// (same field names, same shape). Without them a number reached newName.trim()
// (a 500) and a non-array reached JSON.stringify, storing a JSON scalar that
// parseMuscleGroups then silently read back as [].
router.post("/rename-exercise", denyTrainer, validateSetTiming, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { oldName, newName, primaryMuscles, secondaryMuscles } = req.body
  const split = req.body.split

  if (typeof split !== "string" || !split.trim() || typeof oldName !== "string" || !oldName.trim()) {
    throw new ValidationError("split and oldName are required")
  }
  if (newName !== undefined && (typeof newName !== "string" || !newName.trim()))
    throw new ValidationError("newName must be a non-empty string")

  const updatedCount = await renameExerciseInHistory(
    userId,
    split,
    oldName.trim(),
    newName,
    primaryMuscles,
    secondaryMuscles,
  )
  res.json({ success: true, updatedCount })
})

router.post("/:sessionId/set", idempotent, validateRequired(["exerciseName", "setIndex", "startTime", "endTime"]), validateSetTiming, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")

  // exerciseName is already required by validateRequired and shape-checked
  // by validateSetTiming, both mounted on this route.
  const {
    exerciseName,
    setIndex,
    startTime,
    endTime,
    weight,
    reps,
    note,
    isWarmup,
    primaryMuscles,
    secondaryMuscles,
    machineName,
    rir,
  } = req.body

  // Ownership is enforced inside recordSetTiming's transaction.
  const timing = await recordSetTiming(
    sessionId,
    userId,
    {
      exerciseName: exerciseName.trim(),
      setIndex,
      startTime,
      endTime,
      weight: weight || 0,
      reps: reps || 0,
      note: note || null,
      isWarmup: isWarmup || false,
      primaryMuscles: primaryMuscles ?? [],
      secondaryMuscles: secondaryMuscles ?? [],
      machineName: machineName || null,
      rir: rir ?? null,
    },
    { openWorkoutOnly: !!req.trainer },
  )

  // Watchers get just the set that was recorded. The old push re-read the
  // whole session from the DB and re-sent every set so far on every set, so a
  // 40-set workout sent 40 ever-growing payloads. Fields match what
  // getFriendSessionDetails returns so the spectator's array remains uniform.
  // The fan-out below is a join that used to run on every recorded set,
  // including on a one-person instance where the lifter's own socket is the
  // only one open. No other socket means nothing to deliver.
  if (hasOtherClients(req.user!.uuid)) {
    const set = {
      id: timing.id,
      setIndex,
      weight: weight || 0,
      reps: reps || 0,
      setDuration: timing.setDuration,
      restTime: timing.restTime,
      machineName: timing.machineName,
      exerciseName: exerciseName.trim(),
      exercisePrimaryMuscles: primaryMuscles ?? [],
      exerciseSecondaryMuscles: secondaryMuscles ?? [],
    }
    // Not awaited: the set is already committed, and a failed lookup here used
    // to turn that into a 500, which the idempotency layer doesn't store, so
    // the app's replay inserted the set a second time.
    getLiveAudience(userId)
      .then((audience) => {
        for (const a of audience) {
          if (a.permissionType === "watch_session")
            sendToUser(a.uuid, "live_set_recorded", { sessionId, set })
          // A trainer recording the set is told below, as the trainee is.
          // Otherwise every trainer with an active grant hears about it.
          else if (!req.trainer)
            sendToUser(a.uuid, "trainee_set_recorded", {
              traineeId: req.user!.uuid,
              trainerId: a.uuid,
              trainerUsername: a.username,
              sessionId,
            })
        }
      })
      .catch((err: Error) =>
        logger.warn("[WS] live set push failed:", err.message),
      )
  }

  if (req.trainer) {
    // A trainer recorded the set, and the trainee needs to know their data changed.
    sendToUser(req.user!.uuid, "trainer_set_recorded", trainerEventPayload(req, sessionId))
  }
  void pushWatchProgress(req.user!, sessionId)

  res.json({ success: true, timing })
})

router.patch("/:sessionId/sets/:setId", validateSetTiming, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")
  const setId = parseIntParam(String(req.params.setId), "set ID")

  // Trainer mode may correct a set in the workout being run, not rewrite the
  // trainee's finished history, which remains the trainee's own call.
  const timing = await updateSetTiming(sessionId, setId, userId, req.body, {
    openWorkoutOnly: !!req.trainer,
  })

  if (req.trainer)
    sendToUser(req.user!.uuid, "trainer_set_recorded", trainerEventPayload(req, sessionId))
  void pushWatchProgress(req.user!, sessionId)

  res.json({ success: true, timing })
})

// NOTE: Static paths (/split/:split, /) MUST come before the dynamic
// /:sessionId routes so Express doesn't treat the literal as a session ID.

router.post("/demo", denyTrainer, validateDemoFill, async (req: Request, res: Response) => {
  const result = await fillDemoData(req.user!.id, req.body.days, req.body.split ?? null)
  res.json({ success: true, ...result })
})

router.delete("/demo", denyTrainer, async (req: Request, res: Response) => {
  const { sessions, friends, tracking } = await clearDemoData(req.user!.id)
  res.json({
    success: true,
    deletedCount: sessions,
    deletedFriends: friends,
    deletedTracking: tracking,
  })
})

router.delete("/split/:split", denyTrainer, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const split = String(req.params.split)

  const deletedCount = await deleteAllSessionsForSplit(userId, split)
  res.json({
    success: true,
    deletedCount,
    message: deletedCount
      ? `Deleted ${deletedCount} session(s) for split: ${split}`
      : `No sessions found for split: ${split}`,
  })
})

// Addressed by exercise name + set index, not by set id: the app undoes a set
// it only ever knew by its position in the day. Query params rather than a
// body: DELETE bodies are not parsed here.
router.delete("/:sessionId/sets", denyTrainer, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")

  const exerciseName = req.query.exerciseName
  if (typeof exerciseName !== "string" || !exerciseName.trim())
    throw new ValidationError("exerciseName is required")

  // Not parseIntParam: set indices are 0-based and it rejects anything < 1.
  const setIndex = Number(req.query.setIndex)
  if (!Number.isInteger(setIndex) || setIndex < 0)
    throw new ValidationError("setIndex must be an integer >= 0")

  const deletedCount = await deleteSetByIndex(
    sessionId,
    userId,
    exerciseName,
    setIndex,
  )
  if (deletedCount) void pushWatchProgress(req.user!, sessionId)

  res.json({ success: true, deletedCount })
})

router.post("/:sessionId/end", idempotent, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")

  // alreadyEnded: a retried or double-tapped end is a no-op, not a rewrite of
  // end_time. Nothing changed, so nobody is notified a second time, but the
  // client still gets the row (and the flag) so it can reconcile.
  // Same bound as every other client timestamp: a phone years ahead used to
  // store a workout ending in 2999, and a non-string reached new Date().
  const { session, alreadyEnded } = await endSession(
    sessionId,
    userId,
    parseBackdatedTimestamp(req.body?.endTime || null, "endTime"),
  )

  if (!alreadyEnded) {
    pushSessionStatusToWatchers(
      req.user!,
      null,
      "friend_session_ended",
    )

    if (req.trainer) pushTrainerEvent(req, sessionId, "trainer_session_ended")
    void pushWatchProgress(req.user!, sessionId, true)
  }

  res.json({ success: true, session, alreadyEnded })
})

// Moves a running workout to another program day when the user switches day
// mid-session. Its sets are left in place.
router.patch("/:sessionId", idempotent, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")
  const { dayNumber, dayTitle = null } = req.body

  if (!Number.isInteger(dayNumber) || dayNumber < 1)
    throw new ValidationError("Day number must be a positive integer")
  if (dayTitle !== null && (typeof dayTitle !== "string" || dayTitle.length > 255))
    throw new ValidationError("Day title must be a string of at most 255 characters")

  const session = await updateSessionDay(sessionId, userId, dayNumber, dayTitle)
  res.json({ success: true, session })
})

router.get("/:sessionId", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")

  const session = await getSessionDetails(sessionId, userId)
  res.json({ success: true, session })
})


// Trainer-mode WS events. req.user is the trainee (swapped by
// applyTrainerContext) and req.trainer is the acting trainer, so the payload
// carries both sides of the pair on every event.
function trainerEventPayload(req: Request, sessionId: number) {
  return {
    traineeId: req.user!.uuid,
    trainerId: req.trainer!.uuid,
    trainerUsername: req.trainer!.username,
    sessionId,
  }
}

/** trainer_session_started / trainer_session_ended go to both sides. */
function pushTrainerEvent(req: Request, sessionId: number, type: string): void {
  const payload = trainerEventPayload(req, sessionId)
  sendToUser(req.user!.uuid, type, payload)
  sendToUser(req.trainer!.uuid, type, payload)
}

async function pushSessionStatusToWatchers(
  user: { id: number; uuid: string; username: string },
  sessionId: number | null,
  type: string,
): Promise<void> {
  try {
    const watchers = await getLiveAudience(user.id, "watchers")

    watchers.forEach((w) => {
      sendToUser(w.uuid, type, {
        friendId: user.uuid,
        friendUsername: user.username,
        ...(sessionId != null && { sessionId }),
      })
    })
  } catch (err) {
    logger.warn(
      "[WS] pushSessionStatusToWatchers failed:",
      (err as Error).message,
    )
  }
}

export default router
