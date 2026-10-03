import { Request, Response, NextFunction } from "express"
import { ForbiddenError } from "./errorHandler.js"
import { findTraineeForTrainer } from "../features/auth/auth.model.js"
import { isUuid } from "./validation.js"
import { logger } from "../utils/logger.js"

/**
 * Trainer mode. When `X-Trainee-Id` (the trainee's uuid) is present and the
 * named user has granted the authenticated caller an active `trainer`
 * permission, req.user is swapped to the trainee for the rest of the
 * request: every read and write goes to the trainee's data. The original
 * actor is kept on req.trainer so routes can attach it to WS events. No
 * header → no-op.
 *
 * Mounted after authenticateToken on the routers the feature covers
 * (sessions, program, analytics). /api/auth deliberately never sees it. In
 * particular DELETE /api/auth/account/data remains scoped to the caller, so a
 * trainer cannot wipe a trainee's account.
 *
 * The grant is read/write but never destructive. `denyTrainer` guards every
 * route in the covered routers that erases or overwrites existing data:
 *   - the delete routes, including DELETE /api/sessions/:id/sets (one at a
 *     time is still the trainee's recorded history being deleted)
 *   - POST /api/program/upload (an upsert that replaces the whole program
 *     rather than merging into it)
 *   - POST /api/sessions/rename-exercise (a bulk rewrite of a split's entire
 *     set history) and PATCH /api/program/exercise/rename (re-points the slot
 *     at another shared `exercises` row, changing how the trainee's history
 *     reads)
 * What a trainer CAN write is additive: recording sets, starting and ending
 * workouts, PATCH /exercise/add, /exercise/sets and /exercise/machine, and
 * PUT /api/program/current-day: moving the trainee's day pointer is part of
 * running their session, and it overwrites a pointer rather than data.
 * Destroying a trainee's data stays the trainee's own call, so three routes
 * that remain open are narrowed in trainer mode by their own handlers:
 *   - PATCH /api/sessions/:id/sets/:setId only on a workout still in progress
 *   - /exercise/sets refuses a negative additionalSets
 *   - /exercise/machine refuses a patch that nulls (clears) anything
 * Every trainer write is logged with both uuids and the request id.
 */
export function denyTrainer(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.trainer)
    return next(
      new ForbiddenError("Trainers cannot delete a trainee's data"),
    )
  next()
}

export async function applyTrainerContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = req.headers["x-trainee-id"]
  if (raw == null) return next()

  if (!isUuid(raw)) return next(new ForbiddenError("NOT_A_TRAINER"))

  const trainee = await findTraineeForTrainer(req.user!.id, raw.toLowerCase())
  if (!trainee) return next(new ForbiddenError("NOT_A_TRAINER"))

  req.trainer = {
    userId: req.user!.id,
    uuid: req.user!.uuid,
    username: req.user!.username,
  }
  req.user = trainee
  // Audit trail for writes made on someone else's behalf: nothing in the rows
  // records who wrote them, so the log line is what answers "who changed my
  // program?". Reads aren't logged. Uuids and the request id only, the same
  // identifiers every other log line and WS event already carry.
  if (req.method !== "GET" && req.method !== "HEAD")
    logger.info(
      `[TRAINER] ${req.trainer.uuid} as ${trainee.uuid}: ${req.method} ${req.originalUrl} reqId=${req.reqId ?? "-"}`,
    )
  next()
}
