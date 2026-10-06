// Muscle soreness (DOMS): one episode per row in `soreness`, with the
// check-in trail in `soreness_follow_up`.
//
// This used to be two features writing two tables (`muscle_soreness` for the
// plain "how sore am I today" log and `active_soreness` for episodes with
// follow-ups), which disagreed about the intensity range (1-10 vs 0-10) and
// about the note column's name. One table, one range (0-10), one `note`.

import { pool, formatDateForMySQL, withTransaction } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { ValidationError, NotFoundError } from "@/middleware/errorHandler.js"
import { requireOptionalNote } from "@/middleware/validation.js"

/** Follow-ups returned per episode: the most recent ones, oldest first. */
const FOLLOW_UPS_PER_EPISODE = 20
/** Ceiling on GET /active: open episodes, not a history. */
export const MAX_ACTIVE_EPISODES = 100

type FollowUpStatus = "still_sore" | "better" | "recovered"
type SorenessStatus = "active" | "recovering" | "recovered"

interface SorenessFollowUp {
  id: number
  sorenessId: number
  intensity: number
  status: FollowUpStatus
  note: string | null
  createdAt: string
}

interface SorenessEntry {
  id: number
  muscleGroup: string
  intensity: number
  note: string | null
  loggedAt: string
  status: SorenessStatus
  recoveredAt: string | null
  createdAt: string
  updatedAt: string
  followUps: SorenessFollowUp[]
}

interface SorenessStats {
  totalActiveSoreness: number
  totalRecoveryEpisodes: number
  averageRecoveryDays: number
  mostSoreMuscle: string | null
  heatmapData: Record<string, number>
  severityTrend: Array<{ date: string; averageIntensity: number }>
}

// Aliased to camelCase in SQL, so a row is already the wire shape bar followUps.
type SorenessRow = RowDataPacket & Omit<SorenessEntry, "followUps">
type FollowUpRow = RowDataPacket & SorenessFollowUp

const SORENESS_COLS = `id, muscle_group AS muscleGroup, intensity, note,
       logged_at AS loggedAt, status, recovered_at AS recoveredAt,
       created_at AS createdAt, updated_at AS updatedAt`

const FOLLOW_UP_COLS = `id, soreness_id AS sorenessId, intensity, status, note,
       created_at AS createdAt`

// Known, curated muscle groups. These get first-class treatment in the UI
// (grouped picker, consistent labels) but are not the only thing a user may
// log. See requireMuscleGroup below.
const VALID_MUSCLES = [
  "chest",
  "back",
  "legs",
  "quads",
  "hamstrings",
  "glutes",
  "arms",
  "biceps",
  "triceps",
  "forearms",
  "shoulders",
  "delts",
  "abs",
  "core",
  "calves",
  "lower_back",
  "neck",
  "traps",
] as const
type MuscleGroup = (typeof VALID_MUSCLES)[number]

// Anything else is allowed as a free-form body part as long as it is a
// reasonable, safe string. Not a security boundary (every insert is
// parameterized): just hygiene, so we don't store essays or control
// characters typed by mistake.
const MAX_CUSTOM_MUSCLE_LENGTH = 50
// Letters (incl. accented), numbers, spaces, and the punctuation people
// actually use for body parts: "IT band", "Achilles tendon", "QL (lower back)".
const CUSTOM_MUSCLE_PATTERN = /^[\p{L}\p{N} '\-.()/]+$/u

const FOLLOW_UP_STATUSES: FollowUpStatus[] = [
  "still_sore",
  "better",
  "recovered",
]

function requireMuscleGroup(value: unknown): string {
  const muscle = String(value ?? "").trim()
  const ok =
    VALID_MUSCLES.includes(muscle as MuscleGroup) ||
    (muscle.length > 0 &&
      muscle.length <= MAX_CUSTOM_MUSCLE_LENGTH &&
      CUSTOM_MUSCLE_PATTERN.test(muscle))
  if (!ok) {
    throw new ValidationError(
      `Invalid muscle group. Use one of: ${VALID_MUSCLES.join(", ")}, or a custom ` +
        `name up to ${MAX_CUSTOM_MUSCLE_LENGTH} characters using letters, numbers, ` +
        `spaces, or the punctuation - ' . ( ) /`,
    )
  }
  return muscle
}

/** Matches ck_sor_intensity, so a bad value fails here rather than in MySQL. */
function requireIntensity(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10)
    throw new ValidationError("Soreness intensity must be an integer from 0-10")
  return value as number
}

function requireFollowUpStatus(value: unknown): FollowUpStatus {
  if (!FOLLOW_UP_STATUSES.includes(value as FollowUpStatus))
    throw new ValidationError(
      `Invalid status. Must be one of: ${FOLLOW_UP_STATUSES.join(", ")}`,
    )
  return value as FollowUpStatus
}

/** A follow-up's reported status maps onto the episode's own status. */
function sorenessStatusFor(status: FollowUpStatus): SorenessStatus {
  if (status === "recovered") return "recovered"
  return status === "better" ? "recovering" : "active"
}

export async function logSoreness(
  userId: number,
  muscleGroup: string,
  intensity: number,
  loggedAt?: string | null,
  note?: string | null,
): Promise<SorenessEntry> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO soreness (user_id, muscle_group, intensity, note, logged_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      requireMuscleGroup(muscleGroup),
      requireIntensity(intensity),
      requireOptionalNote(note) ?? null,
      formatDateForMySQL(loggedAt ? loggedAt : new Date()),
    ],
  )
  return getSorenessById(userId, result.insertId)
}

async function getSorenessById(
  userId: number,
  sorenessId: number,
): Promise<SorenessEntry> {
  const [entry] = await listSoreness("user_id = ? AND id = ?", [
    userId,
    sorenessId,
  ])
  if (!entry) throw new NotFoundError("Soreness entry")
  return entry
}

export interface SorenessFilter {
  muscle?: string
  /** Only episodes still active or recovering. */
  activeOnly?: boolean
}

/**
 * The soreness list, optionally narrowed by muscle and/or to open episodes.
 * GET /, /active and /muscle/:muscle all come through here. The active list
 * keeps its own order (most recently updated first) and cap, since it's the
 * "what hurts right now" view rather than a history.
 */
export async function listSorenessEntries(
  userId: number,
  filter: SorenessFilter = {},
  limit = 100,
): Promise<SorenessEntry[]> {
  const where = ["user_id = ?"]
  const params: (string | number)[] = [userId]
  if (filter.muscle !== undefined) {
    where.push("muscle_group = ?")
    params.push(filter.muscle)
  }
  if (filter.activeOnly) where.push("status IN ('active', 'recovering')")
  return listSoreness(
    where.join(" AND "),
    params,
    filter.activeOnly ? "updated_at DESC" : "logged_at DESC",
    filter.activeOnly ? Math.min(limit, MAX_ACTIVE_EPISODES) : limit,
  )
}

export async function addFollowUp(
  userId: number,
  sorenessId: number,
  intensity: number,
  status: FollowUpStatus,
  note?: string | null,
): Promise<SorenessEntry> {
  // Ownership guard: throws NotFoundError unless the episode is the caller's.
  await getSorenessById(userId, sorenessId)
  const [entry] = await applyFollowUps(userId, [
    { sorenessId, intensity, status, note },
  ])
  return entry!
}

/**
 * Apply many follow-ups in one go. Deliberately not a loop over addFollowUp:
 * that opened a connection, a transaction and two ownership reads per item, so
 * a 50-item batch cost ~450 round trips across 50 transactions. Here it is one
 * ownership check, one transaction, one INSERT, and one read back.
 *
 * Ids the caller doesn't own are skipped and reported back in `skipped`. A real
 * DB failure rolls the whole batch back rather than leaving it half-applied.
 */
export async function batchFollowUp(
  userId: number,
  updates: Array<{
    sorenessId: number
    intensity: number
    status: FollowUpStatus
    note?: string | null
  }>,
): Promise<{ entries: SorenessEntry[]; skipped: number[] }> {
  if (updates.length > 50)
    throw new ValidationError("Too many updates in a single batch")
  if (!updates.length) return { entries: [], skipped: [] }

  // query(), not execute(): the IN list's length is the caller's to choose, and
  // every distinct statement text is another server-side prepared statement.
  const [owned] = await pool.query<(RowDataPacket & { id: number })[]>(
    `SELECT id FROM soreness WHERE user_id = ? AND id IN (?)`,
    [userId, updates.map((u) => u.sorenessId)],
  )
  const ownedIds = new Set(owned.map((r) => r.id))
  // Which ids were dropped, not just how many came back: a client that sent 5
  // and got 4 otherwise has no way to tell which episode it failed to update.
  return {
    entries: await applyFollowUps(
      userId,
      updates.filter((u) => ownedIds.has(u.sorenessId)),
    ),
    skipped: updates
      .map((u) => u.sorenessId)
      .filter((id) => !ownedIds.has(id)),
  }
}

async function applyFollowUps(
  userId: number,
  updates: Array<{
    sorenessId: number
    intensity: number
    status: FollowUpStatus
    note?: string | null
  }>,
): Promise<SorenessEntry[]> {
  // Validate everything before opening a transaction: a bad item in the
  // middle of a batch should cost nothing.
  // note: undefined means "leave the episode note alone", while null is an explicit
  // clear, and the two are different on the wire.
  const applicable = updates.map((u) => ({
    sorenessId: u.sorenessId,
    intensity: requireIntensity(u.intensity),
    status: requireFollowUpStatus(u.status),
    note: requireOptionalNote(u.note),
  }))
  if (!applicable.length) return []

  // One episode row gets one UPDATE. When a batch names the same episode twice
  // the later item is applied, as it was when this was a loop of UPDATEs. Every item
  // still becomes its own follow-up row.
  const latest = [...new Map(applicable.map((u) => [u.sorenessId, u])).values()]

  const now = formatDateForMySQL(new Date())
  await withTransaction(async (connection) => {
    // One UPDATE … JOIN over a derived table of the new values, instead of one
    // round trip per item. UNION ALL of SELECTs rather than VALUES ROW(...),
    // which MariaDB doesn't speak. has_note keeps "note absent" (leave it
    // alone) apart from "note: null" (clear it). query(), not execute(), for
    // the same prepared-statement reason as above.
    const rows = latest.map(() => "SELECT ? AS id, ? AS intensity, ? AS status, ? AS recovered_at, ? AS has_note, ? AS note")
    await connection.query(
      `UPDATE soreness s JOIN (${rows.join(" UNION ALL ")}) v ON v.id = s.id
       SET s.intensity = v.intensity, s.status = v.status,
           s.recovered_at = v.recovered_at,
           s.note = IF(v.has_note = 1, v.note, s.note)
       WHERE s.user_id = ?`,
      [
        ...latest.flatMap((u) => [
          u.sorenessId,
          u.intensity,
          sorenessStatusFor(u.status),
          u.status === "recovered" ? now : null,
          u.note !== undefined ? 1 : 0,
          u.note ?? null,
        ]),
        userId,
      ],
    )

    await connection.query(
      `INSERT INTO soreness_follow_up (soreness_id, intensity, status, note) VALUES ?`,
      [applicable.map((u) => [u.sorenessId, u.intensity, u.status, u.note ?? null])],
    )
  })

  return listSoreness(
    "user_id = ? AND id IN (?)",
    [userId, latest.map((u) => u.sorenessId)],
    "updated_at DESC",
  )
}

export async function deleteSorenessEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  // Follow-ups go with it: fk_sfu_soreness is ON DELETE CASCADE.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM soreness WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}

export async function getSorenessStats(
  userId: number,
  days = 30,
): Promise<SorenessStats> {
  // Two queries, one after the other. This used to be six in parallel, which
  // took six pool connections per call. The all-time figures are conditional
  // aggregates in one pass over the user's rows. The windowed heatmap and trend
  // both come out of one (day, muscle) grouping, split in JS.
  const [[totals]] = await pool.execute<
    (RowDataPacket & {
      active: number | null
      recovered: number | null
      avgDays: number | null
      mostSore: string | null
    })[]
  >(
    `SELECT SUM(status IN ('active', 'recovering')) AS active,
            SUM(status = 'recovered') AS recovered,
            AVG(CASE WHEN status = 'recovered' AND recovered_at IS NOT NULL
                     THEN DATEDIFF(recovered_at, logged_at) END) AS avgDays,
            (SELECT muscle_group FROM soreness
              WHERE user_id = ? AND status IN ('active', 'recovering')
              ORDER BY intensity DESC LIMIT 1) AS mostSore
     FROM soreness WHERE user_id = ?`,
    [userId, userId],
  )

  // Leans on idx_sor_user_logged.
  const [windowRows] = await pool.execute<
    (RowDataPacket & { date: string; muscleGroup: string; n: number; total: number })[]
  >(
    `SELECT DATE(logged_at) AS date, muscle_group AS muscleGroup,
            COUNT(*) AS n, SUM(intensity) AS total
     FROM soreness
     WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(logged_at), muscle_group
     ORDER BY date ASC`,
    [userId, days],
  )

  const heatmapData: Record<string, number> = {}
  const byDay = new Map<string, { n: number; total: number }>()
  for (const r of windowRows) {
    heatmapData[r.muscleGroup] = (heatmapData[r.muscleGroup] ?? 0) + Number(r.n)
    const day = byDay.get(r.date) ?? { n: 0, total: 0 }
    day.n += Number(r.n)
    day.total += Number(r.total)
    byDay.set(r.date, day)
  }

  return {
    totalActiveSoreness: Number(totals?.active ?? 0),
    totalRecoveryEpisodes: Number(totals?.recovered ?? 0),
    averageRecoveryDays: Number(Number(totals?.avgDays ?? 0).toFixed(1)),
    mostSoreMuscle: totals?.mostSore ?? null,
    heatmapData,
    severityTrend: [...byDay].map(([date, d]) => ({
      date,
      averageIntensity: Number((d.total / d.n).toFixed(1)),
    })),
  }
}

/**
 * Soreness rows matching `where`, each with its latest FOLLOW_UPS_PER_EPISODE
 * follow-ups attached (oldest first). The follow-ups come back in one batched
 * query rather than one per row.
 *
 * query() rather than execute() for both: a param may be an array that
 * expands into an IN list, and the follow-up IN list is as long as the page,
 * so either would otherwise prepare a new statement per distinct length.
 */
async function listSoreness(
  where: string,
  params: (string | number | number[])[],
  orderBy = "logged_at DESC",
  limit?: number,
): Promise<SorenessEntry[]> {
  const [rows] = await pool.query<SorenessRow[]>(
    `SELECT ${SORENESS_COLS} FROM soreness
     WHERE ${where} ORDER BY ${orderBy}${limit ? " LIMIT ?" : ""}`,
    limit ? [...params, limit] : params,
  )
  if (!rows.length) return []

  const [followUps] = await pool.query<FollowUpRow[]>(
    `SELECT ${FOLLOW_UP_COLS} FROM (
       SELECT f.*, ROW_NUMBER() OVER (
                PARTITION BY soreness_id ORDER BY created_at DESC, id DESC) AS rn
       FROM soreness_follow_up f WHERE soreness_id IN (?)
     ) AS recent
     WHERE rn <= ?
     ORDER BY created_at ASC, id ASC`,
    [rows.map((r) => r.id), FOLLOW_UPS_PER_EPISODE],
  )
  const bySoreness = new Map<number, SorenessFollowUp[]>()
  for (const f of followUps) {
    const list = bySoreness.get(f.sorenessId)
    if (list) list.push(f)
    else bySoreness.set(f.sorenessId, [f])
  }
  return rows.map((r) => ({ ...r, followUps: bySoreness.get(r.id) ?? [] }))
}
