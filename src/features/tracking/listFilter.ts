// The ?muscle= and ?status=active filters of the injury and soreness lists.

import type { Request } from "express"
import { listActiveFilter, listMuscleFilter } from "@/middleware/validation.js"

/** Narrowing options for an injury or soreness list. */
export interface ListFilter {
  /** Only this muscle group. */
  muscle?: string
  /** Only entries still active or recovering. */
  activeOnly?: boolean
}

/** Reads ?muscle= and ?status=active from a list request. */
export function listFilter(req: Request): ListFilter {
  return { muscle: listMuscleFilter(req), activeOnly: listActiveFilter(req) }
}

/** The owner's WHERE clause for a filtered list, with its params. */
export function listFilterWhere(
  userId: number,
  filter: ListFilter,
): { where: string; params: (string | number)[] } {
  const where = ["user_id = ?"]
  const params: (string | number)[] = [userId]
  if (filter.muscle !== undefined) {
    where.push("muscle_group = ?")
    params.push(filter.muscle)
  }
  if (filter.activeOnly) where.push("status IN ('active', 'recovering')")
  return { where: where.join(" AND "), params }
}
