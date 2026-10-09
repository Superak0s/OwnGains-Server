// Menstrual cycles: one row per cycle, plus a phase estimate derived from them.
//
// Cycle *length* is the gap between consecutive cycle_start values, so nothing
// stores a duration that can disagree with the dates. Period/cycle preferences
// live in user_settings with every other preference.

import { pool, formatDateForMySQL, parseMySQLDate } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import {
  ValidationError,
  NotFoundError,
  throwCheckViolation,
} from "@/middleware/errorHandler.js"
import { requireStringList } from "@/middleware/validation.js"
import { getUserSettings } from "@/features/settings/settings.model.js"

interface MenstrualEntry extends RowDataPacket {
  id: number
  cycleStart: string
  cycleEnd: string | null
  /** Parsed by the driver: the column is JSON, not a TEXT blob of JSON. */
  symptoms: string[]
  createdAt: string
  updatedAt: string
}

interface CyclePhase {
  phase: "menstruation" | "follicular" | "ovulation" | "luteal"
  daysInPhase: number
  estimatedEnd: Date
}

interface CycleStats {
  currentPhase: CyclePhase | null
  averageCycleLength: number
  nextPeriodEstimate: Date | null
  lastCycleEntry: MenstrualEntry | null
}

const CYCLE_COLS = `id, cycle_start AS cycleStart, cycle_end AS cycleEnd,
       symptoms, created_at AS createdAt, updated_at AS updatedAt`

const DAY_MS = 24 * 60 * 60 * 1000

// Bounded so the JSON column can't be a megabyte of "symptoms".
const requireSymptoms = (symptoms: unknown): string[] =>
  requireStringList(symptoms, "symptoms", { maxItems: 30, maxLength: 64 })

export async function logMenstrualCycle(
  userId: number,
  cycleStart: string,
  symptoms?: unknown,
): Promise<MenstrualEntry> {
  if (Number.isNaN(new Date(cycleStart).getTime()))
    throw new ValidationError("Invalid cycle start date")

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO menstrual_cycle (user_id, cycle_start, symptoms) VALUES (?, ?, ?)`,
    [
      userId,
      formatDateForMySQL(cycleStart),
      JSON.stringify(requireSymptoms(symptoms)),
    ],
  )
  return getCycleById(userId, result.insertId)
}

async function getCycleById(
  userId: number,
  id: number,
): Promise<MenstrualEntry> {
  const [rows] = await pool.execute<MenstrualEntry[]>(
    `SELECT ${CYCLE_COLS} FROM menstrual_cycle WHERE id = ? AND user_id = ?`,
    [id, userId],
  )
  /* v8 ignore next -- only a row deleted between the write and this read */
  if (!rows[0]) throw new NotFoundError("Menstrual entry")
  return rows[0]
}

/**
 * A cycle is not over when it is logged: the period ends days later, and the
 * symptom list grows while it runs. Before this the row was write-once.
 */
export async function updateMenstrualCycle(
  userId: number,
  id: number,
  updates: { cycleEnd?: string | null; symptoms?: unknown },
): Promise<MenstrualEntry> {
  const fields: string[] = []
  const values: (string | null)[] = []

  if (updates.cycleEnd !== undefined) {
    // ck_mc_dates rejects an end before the start.
    fields.push("cycle_end = ?")
    values.push(updates.cycleEnd ? formatDateForMySQL(updates.cycleEnd) : null)
  }
  if (updates.symptoms !== undefined) {
    fields.push("symptoms = ?")
    values.push(JSON.stringify(requireSymptoms(updates.symptoms)))
  }
  if (!fields.length) throw new ValidationError("No valid fields to update")

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE menstrual_cycle SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
      [...values, id, userId],
    )
    if (result.affectedRows === 0) throw new NotFoundError("Menstrual entry")
    return getCycleById(userId, id)
  } catch (err) {
    // ck_mc_dates: an end before the start is a bad request, not a 500.
    throw throwCheckViolation(err, "Cycle end cannot be before cycle start")
  }
}

export async function getMenstrualHistory(
  userId: number,
  limit = 12,
): Promise<MenstrualEntry[]> {
  const [rows] = await pool.execute<MenstrualEntry[]>(
    `SELECT ${CYCLE_COLS} FROM menstrual_cycle
     WHERE user_id = ? ORDER BY cycle_start DESC LIMIT ?`,
    [userId, limit],
  )
  return rows
}

/**
 * `overrides` lets the caller preview the stats under a different period or
 * cycle length than the one saved in settings: the app's menstrual tab edits
 * both inline before committing them. They replace the *saved* values
 * only: an observed average still takes priority over an overridden cycle length, the
 * same way it wins over the stored one.
 */
export async function getCycleStats(
  userId: number,
  overrides: { periodDays?: number; cycleLengthDays?: number } = {},
): Promise<CycleStats> {
  // One after another, not Promise.all: three small reads don't need three
  // pool connections at once, and a pool of a handful is shared by everyone.
  const [lastRows] = await pool.execute<MenstrualEntry[]>(
    `SELECT ${CYCLE_COLS} FROM menstrual_cycle
     WHERE user_id = ? ORDER BY cycle_start DESC LIMIT 1`,
    [userId],
  )
  // The observed cycle length: the average gap between one cycle_start and
  // the next. No stored duration_days to keep in sync.
  const [avgRows] = await pool.execute<(RowDataPacket & { avgDays: number | null })[]>(
    `SELECT AVG(gap) AS avgDays FROM (
       SELECT DATEDIFF(cycle_start, LAG(cycle_start) OVER (ORDER BY cycle_start)) AS gap
       FROM menstrual_cycle WHERE user_id = ?
     ) AS gaps WHERE gap IS NOT NULL`,
    [userId],
  )
  const settings = await getUserSettings(userId)

  const last = lastRows[0]
  const cycleLength =
    Number(avgRows[0]?.avgDays) ||
    overrides.cycleLengthDays ||
    settings.cycleLengthDays
  const periodDays = overrides.periodDays ?? settings.cyclePeriodDays

  if (!last) {
    return {
      currentPhase: null,
      averageCycleLength: Math.round(cycleLength),
      nextPeriodEstimate: null,
      lastCycleEntry: null,
    }
  }

  // cycle_start comes back zoneless ("2026-09-08 22:45:33", stored UTC).
  // `new Date(...)` would read it as local time and shift the phase by the
  // box's offset.
  const start = parseMySQLDate(last.cycleStart)
  const day = Math.floor((Date.now() - start.getTime()) / DAY_MS)
  const endOf = (n: number) => new Date(start.getTime() + n * DAY_MS)
  const nextPeriodEstimate = endOf(Math.ceil(cycleLength))

  // A deliberately simple model: period, then a fixed follicular and ovulation
  // window, then luteal until the next period is due.
  // ponytail: fixed windows, not a fertility tracker. Widen only if asked.
  const follicularEnd = periodDays + 7
  const ovulationEnd = periodDays + 11
  const windows = [
    ["menstruation", 0, periodDays],
    ["follicular", periodDays, follicularEnd],
    ["ovulation", follicularEnd, ovulationEnd],
  ] as const
  const w = windows.find(([, , end]) => day <= end)
  const currentPhase: CyclePhase = w
    ? { phase: w[0], daysInPhase: day - w[1], estimatedEnd: endOf(w[2]) }
    : {
        phase: "luteal",
        daysInPhase: day - ovulationEnd,
        estimatedEnd: nextPeriodEstimate,
      }

  return {
    currentPhase,
    averageCycleLength: Math.round(cycleLength),
    nextPeriodEstimate,
    lastCycleEntry: last,
  }
}

export async function deleteMenstrualEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM menstrual_cycle WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}
