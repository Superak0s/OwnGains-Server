// Live spectating of a friend's workout.
// Mounted by sharing.routes.ts, which runs authenticateToken first.

import { Router, Request, Response } from "express"
import { NotFoundError, ForbiddenError } from "@/middleware/errorHandler.js"
import { sendToUser } from "@/ws/wsServer.js"
import {
  resolveFriendAccess,
  getFriendSessionDetails,
  getUserActiveSessionStatus,
} from "./sharing.model.js"
import { parseIntParam } from "@/middleware/validation.js"

const router: Router = Router()

/**
 * Who is currently watching whose live session.
 *
 * There is no "stop watching" call (the app just stops polling the live
 * route), so a watch is kept open by polling and expires on silence. In-process
 * state, like the WS rate counters: this server is single-instance, and a
 * restart only costs a watcher one `watch_started` on their next poll.
 */
const WATCH_IDLE_MS = 60_000

// Both ids are uuids: the watcher's goes out in the owner's WS events, and the
// friend's is the WS registry key those events are sent to.
interface Watch {
  watcherId: string
  watcherUsername: string
  friendId: string
  sessionId: number
  since: Date
  timer: NodeJS.Timeout
}

const activeWatches = new Map<string, Watch>()

function noteWatch(
  watcherId: string,
  watcherUsername: string,
  friendId: string,
  sessionId: number,
): void {
  const key = `${watcherId}:${sessionId}`
  const existing = activeWatches.get(key)

  // unref: a pending expiry must never be the reason the process (or a test
  // run) remains alive.
  const timer = setTimeout(() => {
    activeWatches.delete(key)
    sendToUser(friendId, "watch_stopped", {
      watcherId,
      watcherUsername,
      sessionId,
    })
  }, WATCH_IDLE_MS)
  timer.unref()

  if (existing) {
    // Every poll refreshes the deadline, but only the first one announces the
    // watcher, otherwise the owner gets a notification every few seconds.
    clearTimeout(existing.timer)
    activeWatches.set(key, { ...existing, timer })
    return
  }

  activeWatches.set(key, {
    watcherId,
    watcherUsername,
    friendId,
    sessionId,
    since: new Date(),
    timer,
  })
  sendToUser(friendId, "watch_started", {
    watcherId,
    watcherUsername,
    sessionId,
  })
}

/**
 * Whether a friend is working out right now is visible to every friend: the
 * joint-session status routes answer it so the app can offer "train
 * together". What the watch_session grant protects is the workout itself
 * (/live below, and the live_set_recorded pushes). This route keeps its grant
 * check so an app without the grant is never handed a session id to poll.
 */
router.get("/watch/friend/:friendId/active", async (req: Request, res: Response) => {
  const {
    id: friendId,
    friends,
    granted: allowed,
  } = await resolveFriendAccess(req.user!.id, req.params.friendId, "friendId", "watch_session")
  if (!friends) throw new ForbiddenError("Not friends")
  if (!allowed)
    throw new ForbiddenError("Friend hasn't granted you watch session access")

  const status = await getUserActiveSessionStatus(friendId)
  if (!status.hasActiveSession) throw new NotFoundError("Active session")

  res.json({ success: true, session: { sessionId: status.sessionId } })
})

router.get("/watch/friend/:friendId/session/:sessionId/live", async (req: Request, res: Response) => {
  const sessionId = parseIntParam(String(req.params.sessionId), "sessionId")
  const friend = await resolveFriendAccess(
    req.user!.id,
    req.params.friendId,
    "friendId",
    "watch_session",
  )
  const { id: friendId, friends, granted: allowed } = friend
  if (!friends) throw new ForbiddenError("Not friends")
  if (!allowed) throw new ForbiddenError("No watch permission")

  const status = await getUserActiveSessionStatus(friendId)
  if (!status.hasActiveSession || status.sessionId !== sessionId)
    throw new NotFoundError("Active session")

  const session = await getFriendSessionDetails(friendId, sessionId)
  if (!session) throw new NotFoundError("Session")

  // Only after every access check: a caller who can't watch never registers as
  // a watcher, and the owner is never told about them.
  noteWatch(req.user!.uuid, req.user!.username, friend.uuid, sessionId)

  res.json({ success: true, liveSession: session })
})

export default router
