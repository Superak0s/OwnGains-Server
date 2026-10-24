// Injury tracking model

import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import {
  ValidationError,
  NotFoundError,
  throwCheckViolation,
} from "@/middleware/errorHandler.js"
import { requireOptionalNote } from "@/middleware/validation.js"
import { listFilterWhere, type ListFilter } from "../listFilter.js"

type InjuryType =
  | "strain"
  | "sprain"
  | "tendonitis"
  | "fracture"
  | "dislocation"
  | "tear"
  | "overuse"
  | "surgery"
  | "other"

type InjuryStatus = "active" | "recovering" | "recovered"

const VALID_INJURY_TYPES: InjuryType[] = [
  "strain",
  "sprain",
  "tendonitis",
  "fracture",
  "dislocation",
  "tear",
  "overuse",
  "surgery",
  "other",
]

const VALID_STATUSES: InjuryStatus[] = ["active", "recovering", "recovered"]

function requirePainLevel(painLevel: number): number {
  if (!Number.isInteger(painLevel) || painLevel < 0 || painLevel > 10)
    throw new ValidationError("Pain level must be an integer from 0-10")
  return painLevel
}

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface InjuryRecord extends RowDataPacket {
  id: number
  muscleGroup: string
  injuryType: InjuryType
  painLevel: number
  startDate: Date
  recoveryDate: Date | null
  note: string | null
  status: InjuryStatus
  createdAt: Date
  updatedAt: Date
}

const INJURY_COLS = `id, muscle_group AS muscleGroup, injury_type AS injuryType,
       pain_level AS painLevel, start_date AS startDate,
       recovery_date AS recoveryDate, note, status,
       created_at AS createdAt, updated_at AS updatedAt`

/**
 * Records an injury.
 *
 * @param userId - Numeric id of the owner.
 * @param muscleGroup - Affected muscle group.
 * @param injuryType - One of the allowed injury types.
 * @param painLevel - Pain level at the start.
 * @param startDate - When the injury began.
 * @param note - Optional free text.
 * @returns The stored injury.
 * @throws ValidationError for an unknown injury type.
 */
export async function logInjury(
  userId: number,
  muscleGroup: string,
  injuryType: InjuryType,
  painLevel: number,
  startDate: string,
  note?: string | null,
): Promise<InjuryRecord> {
  if (!VALID_INJURY_TYPES.includes(injuryType)) {
    throw new ValidationError(
      `Invalid injury type. Must be one of: ${VALID_INJURY_TYPES.join(", ")}`,
    )
  }
  requirePainLevel(painLevel)

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO injuries (user_id, muscle_group, injury_type, pain_level, start_date, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      muscleGroup,
      injuryType,
      painLevel,
      formatDateForMySQL(startDate || new Date()),
      requireOptionalNote(note) ?? null,
    ],
  )
  return getInjuryById(userId, result.insertId)
}

async function getInjuryById(
  userId: number,
  injuryId: number,
): Promise<InjuryRecord> {
  const [rows] = await pool.execute<InjuryRecord[]>(
    `SELECT ${INJURY_COLS} FROM injuries WHERE id = ? AND user_id = ?`,
    [injuryId, userId],
  )
  /* v8 ignore next -- race: called right after this user wrote the row */
  if (!rows[0]) throw new NotFoundError("Injury")
  return rows[0]
}

/**
 * The injury list, optionally narrowed by muscle and/or to unhealed ones.
 * GET / takes the filters as ?muscle= and ?status=active. Four fixed
 * statement shapes at most.
 */
export async function listInjuries(
  userId: number,
  filter: ListFilter = {},
  limit = 100,
): Promise<InjuryRecord[]> {
  const { where, params } = listFilterWhere(userId, filter)
  const [rows] = await pool.execute<InjuryRecord[]>(
    `SELECT ${INJURY_COLS} FROM injuries WHERE ${where}
     ORDER BY created_at DESC LIMIT ?`,
    [...params, limit],
  )
  return rows
}

/**
 * An injury is the one tracking record expected to change over weeks: pain
 * drops, it heals, it gets a date. It had no writer but INSERT, so a mistyped
 * pain level was permanent and nothing could ever be marked recovered.
 */
export async function updateInjury(
  userId: number,
  injuryId: number,
  updates: {
    painLevel?: number
    status?: InjuryStatus
    recoveryDate?: string | null
    note?: string | null
  },
): Promise<InjuryRecord> {
  const fields: string[] = []
  const values: (string | number | null)[] = []

  if (updates.painLevel !== undefined) {
    fields.push("pain_level = ?")
    values.push(requirePainLevel(updates.painLevel))
  }
  if (updates.status !== undefined) {
    if (!VALID_STATUSES.includes(updates.status))
      throw new ValidationError(
        `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      )
    fields.push("status = ?")
    values.push(updates.status)
  }
  if (updates.recoveryDate !== undefined) {
    // ck_inj_dates rejects a recovery date before the start date.
    fields.push("recovery_date = ?")
    values.push(
      updates.recoveryDate ? formatDateForMySQL(updates.recoveryDate) : null,
    )
  }
  if (updates.note !== undefined) {
    fields.push("note = ?")
    values.push(requireOptionalNote(updates.note) ?? null)
  }

  if (fields.length === 0) throw new ValidationError("No valid fields to update")

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE injuries SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
      [...values, injuryId, userId],
    )
    if (result.affectedRows === 0) throw new NotFoundError("Injury")
    return getInjuryById(userId, injuryId)
  } catch (err) {
    // ck_inj_dates: a recovery date before the start is a bad request.
    throw throwCheckViolation(err, "Recovery date cannot be before start date")
  }
}

/**
 * Deletes an injury.
 *
 * @param userId - Numeric id of the owner.
 * @param injuryId - Id of the injury.
 * @returns False when nothing was deleted.
 */
export async function deleteInjury(
  userId: number,
  injuryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM injuries WHERE id = ? AND user_id = ?`,
    [injuryId, userId],
  )
  return result.affectedRows > 0
}
