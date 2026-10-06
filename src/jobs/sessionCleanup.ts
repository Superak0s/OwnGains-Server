// Server-side backstop for abandoned workout sessions.
//
// The client already has its own 30-minute inactivity auto-end
// (WorkoutContext's checkAndEndStaleSession), but that only runs while the
// app is open. If the user force-closes the app, the phone dies, or the OS
// kills the JS process mid-workout, that logic never runs and the session
// (and the day it belongs to) remains "open" in the DB indefinitely. This
// job is the server-side equivalent: it runs on its own schedule regardless
// of whether any client is connected, and closes anything that's gone
// quiet for too long.

import { endStaleSessions } from "../features/workouts/workouts.model.js"
import { purgeExpiredIdempotencyKeys } from "../middleware/idempotency.js"
import {
  purgeDeletedAccounts,
  purgeExpiredRefreshTokens,
} from "../features/auth/auth.model.js"
import { purgeUnconsentedAccounts } from "../features/auth/user.model.js"
import { purgeStaleThrottles } from "../features/auth/throttle.model.js"
import { purgeJointSessions } from "../features/social/sharing/sharing.model.js"
import {
  purgeExpiredCooldowns,
  purgeOldReports,
} from "../features/social/friends/friends.model.js"
import { sendToUser } from "../ws/wsServer.js"
import { logger } from "../utils/logger.js"

// Keep this in sync with INACTIVITY_THRESHOLD_MS on the client
// (utils/session.ts): both should represent the same 30-minute idea.
const INACTIVITY_THRESHOLD_MINUTES = 30

// How often the server checks for stale sessions. Doesn't need to be tight:
// a session that's 30-45 minutes stale instead of exactly 30 makes no
// practical difference, and this keeps DB load low.
const CHECK_INTERVAL_MS = 5 * 60 * 1000

let cleanupTimer: ReturnType<typeof setInterval> | null = null
/** The run in progress, if any. Shutdown waits on it before closing the pool. */
let inFlight: Promise<void> | null = null

function tick(): void {
  if (inFlight) return
  inFlight = runStaleSessionCleanup().finally(() => {
    inFlight = null
  })
}

// Overlapping runs are excluded by endStaleSessions' GET_LOCK (so also across
// processes sharing the database). Each batch locks, ends and reports its
// workouts in one transaction.
//
// Exported so the test can drive a sweep directly. The scheduler runs this
// once on start and then only every 5 minutes, and against a DB with
// concurrent writers one sweep can lose a race on `workouts` (a lock wait
// or deadlock), log it, and legitimately do nothing until the next tick,
// which is fine in production and makes any test that polls for a fixed
// window after start racy by construction.
export async function runStaleSessionCleanup(): Promise<void> {
  try {
    const ended = await endStaleSessions(INACTIVITY_THRESHOLD_MINUTES)
    if (ended.length > 0) {
      logger.info(`[SESSION_CLEANUP] Auto-ended ${ended.length} session(s)`)
      // Tell the owner's device, so it can show the workout as ended. A set it
      // still posts is kept: recordSetTiming accepts it and moves end_time
      // forward. A user with no open socket misses it and re-syncs on next launch.
      // Only workouts this sweep actually ended are listed.
      for (const { id, userId } of ended)
        sendToUser(userId, "session_auto_ended", { sessionId: id })
    }
  } catch (err) {
    logger.error(
      "[SESSION_CLEANUP] Cleanup run failed:",
      (err as Error).message,
    )
  }

  // Same cadence suits every expiring store: none of them cares about a few
  // minutes. Separate try blocks so one failing doesn't skip the others.
  const purges: [string, () => Promise<unknown>][] = [
    // Keys live 48h.
    ["Idempotency-key", () => purgeExpiredIdempotencyKeys()],
    // Used to run unbounded inside every token issue.
    ["Refresh-token", () => purgeExpiredRefreshTokens()],
    ["Joint-session", () => purgeJointSessions()],
    ["Friend-request cooldown", () => purgeExpiredCooldowns()],
    ["User-report", () => purgeOldReports()],
    ["Sign-in throttle", () => purgeStaleThrottles()],
    ["Unconsented-account", () => purgeUnconsentedAccounts()],
    // Also runs on boot, so accounts a backup restore brought back are gone
    // within moments of the server starting on the restored database.
    [
      "Deleted-account",
      async () => {
        const n = await purgeDeletedAccounts()
        if (n > 0)
          logger.warn(`[SESSION_CLEANUP] Re-deleted ${n} account(s) restored from a backup`)
      },
    ],
  ]
  for (const [name, purge] of purges) {
    try {
      await purge()
    } catch (err) {
      logger.error(`[SESSION_CLEANUP] ${name} purge failed:`, (err as Error).message)
    }
  }
}

export function startStaleSessionCleanup(): void {
  if (cleanupTimer) {
    logger.warn("[SESSION_CLEANUP] Already running, ignoring duplicate start")
    return
  }

  // Run once immediately on boot to catch anything that went stale while
  // the server was down, then settle into the regular interval.
  tick()

  cleanupTimer = setInterval(tick, CHECK_INTERVAL_MS)

  logger.info(
    `[SESSION_CLEANUP] Scheduled every ${CHECK_INTERVAL_MS / 60000}m ` +
      `(inactivity threshold: ${INACTIVITY_THRESHOLD_MINUTES}m)`,
  )
}

/** Stops the schedule. The returned promise settles once any in-flight run has. */
export function stopStaleSessionCleanup(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
  return inFlight ?? Promise.resolve()
}
