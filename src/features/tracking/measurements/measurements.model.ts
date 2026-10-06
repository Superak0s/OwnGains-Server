// The one table that stores every scalar body metric.
//
// body_weight, body_measurements, hydration_log, body_fat_measurements and
// measurement_custom_values were five tables of identical shape (one number,
// per user, per timestamp, charted over time) with five sets of near-identical
// log/history/delete functions. This module is that table and those functions.
// The feature models above it only pick a metric key and shape the response.
//
// Keep to the rule in schema.sql: a *scalar* series belongs here, anything
// with internal structure (a set, a photo, a cycle, a meal) keeps its own table.
//
// Statement text never depends on user input. pool.execute prepares one
// server-side statement per distinct SQL string per connection, and MySQL's
// global max_prepared_stmt_count is shared by every user, so a query whose
// text varied with the user's metric keys, or with how many were asked for,
// let one account exhaust it for everyone. So metric keys are only ever
// bound values, IN lists are padded to a fixed size, and the pivot into
// per-metric columns happens in JS.

import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError, ConflictError } from "@/middleware/errorHandler.js"
import { requireOptionalNote } from "@/middleware/validation.js"

/**
 * Built-in metric keys. A user-defined key comes from metric_definitions
 * instead. These need no row there because the client already knows their
 * labels and units.
 *
 * Adding a tracked metric is adding a line here. It is no longer DDL.
 */
export const METRICS = {
  weightKg: "weight_kg",
  bodyFatPct: "body_fat_pct",
  waistCm: "waist_cm",
  neckCm: "neck_cm",
  hipCm: "hip_cm",
  armLeftCm: "arm_left_cm",
  armRightCm: "arm_right_cm",
  chestCm: "chest_cm",
  waterMl: "water_ml",
} as const

const BUILT_IN_METRICS: readonly string[] = Object.values(METRICS)

/**
 * Metrics where two entries at the same instant are two things that happened
 * (two glasses of water), not one reading logged twice. They get a plain
 * INSERT with the next entry_seq instead of an upsert. See logAdditiveMetric.
 */
const ADDITIVE_METRICS: ReadonlySet<string> = new Set([METRICS.waterMl])

/**
 * Plausible range per built-in metric, checked in logMetrics so every route
 * that writes one gets it. These used to live only in the thin routers
 * (/bodystats/weight, /hydration, /bodystats/bodyfat/log), so the same value
 * sent through POST /measurements skipped them and a 5,000 kg weigh-in was
 * stored. Anything not listed only has to be > 0.
 */
const METRIC_BOUNDS: Partial<Record<string, { min: number; max: number; message: string }>> = {
  [METRICS.weightKg]: { min: 20, max: 500, message: "Weight must be between 20-500 kg" },
  [METRICS.bodyFatPct]: {
    min: 0,
    max: 100,
    message: "Body fat percentage must be between 1-100%",
  },
  [METRICS.waterMl]: {
    min: 0,
    max: 10000,
    message: "Hydration amount seems unrealistic (max 10L)",
  },
}

/** Most metrics one grouped read or grouped delete may name (`?metrics=`). */
export const MAX_METRICS_PER_QUERY = 10
/** Most values one measuring session may include (POST `values`). */
export const MAX_VALUES_PER_ENTRY = 20
/** Most user-defined metrics per account. */
const MAX_DEFINITIONS_PER_USER = 50

/**
 * `?, ?, …` for exactly `size` slots, and `values` padded to fill them by
 * repeating the last one, since a duplicate in an IN list changes nothing. One
 * statement text per call site, however many values the caller sent.
 */
function fixedIn<T>(values: readonly T[], size: number): { sql: string; params: T[] } {
  if (values.length === 0 || values.length > size)
    throw new Error(`fixedIn: ${values.length} values for ${size} slots`)
  const params = [...values]
  while (params.length < size) params.push(values[values.length - 1]!)
  return { sql: Array(size).fill("?").join(", "), params }
}

/**
 * The shape every stored key must have. It no longer reaches SQL text, but
 * ck_md_key_name repeats it in the DDL and clients rely on it being a tidy
 * identifier, so it stays the rule.
 */
const METRIC_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

function requireMetricKeyShape(metric: string): void {
  if (!METRIC_KEY_PATTERN.test(metric))
    throw new ValidationError(
      `Invalid metric key: ${metric}. Use lowercase letters, digits and ` +
        `underscores, starting with a letter, up to 64 characters.`,
      null,
      "METRIC_UNKNOWN",
    )
}

interface MetricSample {
  metric: string
  value: number
}

export interface MetricEntry extends RowDataPacket {
  id: number
  metric: string
  value: number
  measuredAt: Date | string
  note: string | null
  createdAt: Date | string
}

const ENTRY_COLS = `id, metric, value, measured_at AS measuredAt, note,
  created_at AS createdAt`

/**
 * Write one or more samples under one shared `measured_at`, which is what
 * makes them one measuring session: the body-fat log writes body_fat_pct next to
 * the circumferences it was computed from, and those circumferences then appear
 * on their own charts for free.
 *
 * Writing the same metric at the same instant twice overwrites rather than
 * duplicating (uq_m_user_metric_at_seq, entry_seq 0). Two devices that were both
 * offline for a week replay the same days on reconnect, and the user has no way
 * to tell which of the resulting twin points is real, so a re-sync has to be a
 * no-op. Additive metrics (water) are the exception. See logAdditiveMetric.
 *
 * Returns the lowest id in the session: the handle the delete endpoints use to
 * find the group again. It is read back rather than taken from insertId, which
 * an upsert only sets for rows it actually inserted.
 */
export async function logMetrics(
  userId: number,
  samples: MetricSample[],
  measuredAt?: string | Date | null,
  note?: string | null,
): Promise<number> {
  if (samples.length === 0)
    throw new ValidationError("At least one measurement is required")
  if (samples.length > MAX_VALUES_PER_ENTRY)
    throw new ValidationError(
      `At most ${MAX_VALUES_PER_ENTRY} measurements per entry`,
    )
  for (const s of samples) {
    // ck_m_value enforces this too. Catching it here gives the user the metric
    // name instead of a driver-level constraint message.
    if (!Number.isFinite(s.value) || s.value <= 0)
      throw new ValidationError(`${s.metric} must be a number greater than 0`)
    const bounds = METRIC_BOUNDS[s.metric]
    if (bounds && (s.value < bounds.min || s.value > bounds.max))
      throw new ValidationError(bounds.message)
  }
  const cleanNote = requireOptionalNote(note) ?? null

  const ts = formatDateForMySQL(measuredAt ? measuredAt : new Date())
  const upserts = samples.filter((s) => !ADDITIVE_METRICS.has(s.metric))
  const ids: number[] = []

  if (upserts.length) {
    // query(), not execute(): the row count varies, and VALUES ? expands the
    // nested array client-side instead of preparing a statement per count.
    await pool.query<ResultSetHeader>(
      `INSERT INTO measurements (user_id, metric, value, measured_at, note) VALUES ?
       ON DUPLICATE KEY UPDATE value = VALUES(value), note = VALUES(note)`,
      [upserts.map((s) => [userId, s.metric, s.value, ts, cleanNote])],
    )
    const keys = fixedIn(upserts.map((s) => s.metric), MAX_VALUES_PER_ENTRY)
    const [rows] = await pool.execute<(RowDataPacket & { id: number })[]>(
      `SELECT MIN(id) AS id FROM measurements
       WHERE user_id = ? AND measured_at = ? AND entry_seq = 0
         AND metric IN (${keys.sql})`,
      [userId, ts, ...keys.params],
    )
    ids.push(rows[0].id)
  }
  for (const s of samples.filter((x) => ADDITIVE_METRICS.has(x.metric)))
    ids.push(await logAdditiveMetric(userId, s, ts, cleanNote))

  return Math.min(...ids)
}

/**
 * A plain insert that never overwrites: the row takes the next free entry_seq
 * at its (user, metric, measured_at), so two 250 ml drinks both backdated to
 * the app's default 09:00 are two rows, not one that silently replaced the
 * other. Replays are deduplicated by Idempotency-Key at the route instead.
 * A concurrent insert at the same instant can take the same seq first. That
 * shows up as a duplicate key (or an InnoDB deadlock on the gap lock) and is
 * retried with the next one.
 */
async function logAdditiveMetric(
  userId: number,
  sample: MetricSample,
  ts: string,
  note: string | null,
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO measurements (user_id, metric, value, measured_at, note, entry_seq)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(entry_seq) + 1, 0) FROM measurements
         WHERE user_id = ? AND metric = ? AND measured_at = ?`,
        [userId, sample.metric, sample.value, ts, note, userId, sample.metric, ts],
      )
      return result.insertId
    } catch (err) {
      const errno = (err as { errno?: number }).errno
      // 1062 = ER_DUP_ENTRY, 1213 = ER_LOCK_DEADLOCK
      if (attempt < 3 && (errno === 1062 || errno === 1213)) continue
      throw err
    }
  }
}

export async function getMetricHistory(
  userId: number,
  metric: string,
  limit: number,
): Promise<MetricEntry[]> {
  const [rows] = await pool.execute<MetricEntry[]>(
    `SELECT ${ENTRY_COLS} FROM measurements
     WHERE user_id = ? AND metric = ? ORDER BY measured_at DESC LIMIT ?`,
    [userId, metric, limit],
  )
  return rows
}

export async function getLatestMetric(
  userId: number,
  metric: string,
): Promise<MetricEntry | null> {
  const rows = await getMetricHistory(userId, metric, 1)
  return rows[0] ?? null
}

export async function deleteMetricEntry(
  userId: number,
  entryId: number,
  metric: string,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM measurements WHERE id = ? AND user_id = ? AND metric = ?`,
    [entryId, userId, metric],
  )
  return result.affectedRows > 0
}

/** Delete one measurement by id, whatever metric it holds. */
export async function deleteMeasurement(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM measurements WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}

/**
 * A session from getMetricGroups: id, measuredAt, note, and one number-or-null
 * per requested alias in `values`.
 */
type MetricGroup = {
  id: number
  measuredAt: string
  note: string | null
  values: Record<string, number | null>
}

/**
 * One row per measuring session, with the requested metrics pivoted into
 * properties named by their alias (`{ alias: metricKey }`). A metric not
 * recorded in a session is null. `require` names the metric that has to be
 * present for a session to count: the body-fat history wants sessions that
 * produced a percentage, not every session that happened to record a waist.
 *
 * The database returns (measured_at, metric, value) rows for the newest
 * `limit` sessions and the pivot happens here. The old SQL pivot put each alias
 * into the statement text.
 */
export async function getMetricGroups(
  userId: number,
  metrics: Record<string, string>,
  limit: number,
  require?: string,
): Promise<MetricGroup[]> {
  const aliases = Object.keys(metrics)
  if (aliases.length > MAX_METRICS_PER_QUERY)
    throw new ValidationError(
      `At most ${MAX_METRICS_PER_QUERY} metrics per request`,
    )
  if (require && !aliases.some((a) => metrics[a] === require))
    throw new Error(`${require} is not in the pivot`)
  const keys = fixedIn(
    aliases.map((a) => metrics[a]!),
    MAX_METRICS_PER_QUERY,
  )

  // Two fixed statement texts: with and without the required metric.
  const [rows] = await pool.execute<
    (RowDataPacket & {
      id: number
      measuredAt: string
      metric: string
      value: number
      note: string | null
    })[]
  >(
    `SELECT m.id, m.measured_at AS measuredAt, m.metric, m.value, m.note
     FROM measurements m
     JOIN (SELECT measured_at FROM measurements
           WHERE user_id = ? AND ${require ? "metric = ?" : `metric IN (${keys.sql})`}
           GROUP BY measured_at ORDER BY measured_at DESC LIMIT ?) AS s
       ON s.measured_at = m.measured_at
     WHERE m.user_id = ? AND m.metric IN (${keys.sql})
     ORDER BY m.measured_at DESC, m.id ASC`,
    [
      userId,
      ...(require ? [require] : keys.params),
      limit,
      userId,
      ...keys.params,
    ],
  )

  // Same semantics as the SQL it replaces: MIN(id), MAX(note) and MAX(value)
  // per metric within a session.
  const groups = new Map<string, MetricGroup>()
  for (const r of rows) {
    let g = groups.get(r.measuredAt)
    if (!g) {
      g = { id: r.id, measuredAt: r.measuredAt, note: null, values: {} }
      for (const a of aliases) g.values[a] = null
      groups.set(r.measuredAt, g)
    }
    if (r.id < g.id) g.id = r.id
    if (r.note != null && (g.note == null || r.note > g.note)) g.note = r.note
    for (const a of aliases) {
      if (metrics[a] !== r.metric) continue
      const current = g.values[a]
      if (current == null || r.value > current) g.values[a] = r.value
    }
  }
  return [...groups.values()]
}

/**
 * Delete a whole measuring session: every listed metric sharing the
 * `measured_at` of the row identified by `entryId`. This is how a body-fat log
 * entry is removed: it was one row before the merge, so removing one id has to
 * remove the circumferences filed with it.
 */
export async function deleteMetricGroup(
  userId: number,
  entryId: number,
  metrics: readonly string[],
): Promise<boolean> {
  if (metrics.length > MAX_METRICS_PER_QUERY)
    throw new ValidationError(
      `At most ${MAX_METRICS_PER_QUERY} metrics per request`,
    )
  const keys = fixedIn(metrics, MAX_METRICS_PER_QUERY)
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM measurements
     WHERE user_id = ? AND metric IN (${keys.sql})
       AND measured_at = (SELECT measured_at FROM (
             SELECT measured_at FROM measurements WHERE id = ? AND user_id = ?
           ) AS anchor)`,
    [userId, ...keys.params, entryId, userId],
  )
  return result.affectedRows > 0
}

// ─── User-defined metrics ─────────────────────────────────────────────────────

interface MetricDefinition extends RowDataPacket {
  id: number
  keyName: string
  label: string
  unit: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

const DEFINITION_COLS = `id, key_name AS keyName, label, unit,
  created_at AS createdAt, updated_at AS updatedAt`

export async function createMetricDefinition(
  userId: number,
  keyName: string,
  label: string,
  unit?: string | null,
): Promise<MetricDefinition> {
  if (!keyName || !label)
    throw new ValidationError("keyName and label are required")
  requireMetricKeyShape(keyName)
  if (BUILT_IN_METRICS.includes(keyName))
    throw new ValidationError(`${keyName} is a built-in metric`)

  // Count-then-insert. A race can land one over, which is fine for a bound
  // whose job is "not unbounded".
  const [[{ n }]] = await pool.execute<(RowDataPacket & { n: number })[]>(
    `SELECT COUNT(*) AS n FROM metric_definitions WHERE user_id = ?`,
    [userId],
  )
  if (n >= MAX_DEFINITIONS_PER_USER)
    throw new ValidationError(
      `You can define at most ${MAX_DEFINITIONS_PER_USER} custom metrics`,
      null,
      "METRIC_LIMIT",
    )

  // uq_md_user_key: a duplicate key is a conflict, not a 500.
  let result: ResultSetHeader
  try {
    ;[result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO metric_definitions (user_id, key_name, label, unit) VALUES (?, ?, ?, ?)`,
      [userId, keyName, label, unit ?? null],
    )
  } catch (err) {
    if ((err as { errno?: number }).errno === 1062)
      throw new ConflictError(
        `Metric ${keyName} already exists`,
        "DUPLICATE_METRIC",
      )
    throw err
  }
  const [rows] = await pool.execute<MetricDefinition[]>(
    `SELECT ${DEFINITION_COLS} FROM metric_definitions WHERE id = ?`,
    [result.insertId],
  )
  return rows[0]
}

export async function getMetricDefinitions(
  userId: number,
): Promise<MetricDefinition[]> {
  const [rows] = await pool.execute<MetricDefinition[]>(
    `SELECT ${DEFINITION_COLS} FROM metric_definitions
     WHERE user_id = ? ORDER BY created_at ASC`,
    [userId],
  )
  return rows
}

/**
 * Reject a metric key the caller has not defined. Built-ins are always allowed.
 * Anything else needs a metric_definitions row, which is what keeps
 * `measurements.metric` from becoming a free-text dumping ground.
 */
export async function requireKnownMetrics(
  userId: number,
  metrics: readonly string[],
): Promise<void> {
  const custom = [...new Set(metrics.filter((m) => !BUILT_IN_METRICS.includes(m)))]
  if (!custom.length) return
  custom.forEach(requireMetricKeyShape)
  if (custom.length > MAX_VALUES_PER_ENTRY)
    throw new ValidationError(`At most ${MAX_VALUES_PER_ENTRY} metrics per request`)

  const keys = fixedIn(custom, MAX_VALUES_PER_ENTRY)
  const [rows] = await pool.execute<(RowDataPacket & { key_name: string })[]>(
    `SELECT key_name FROM metric_definitions
     WHERE user_id = ? AND key_name IN (${keys.sql})`,
    [userId, ...keys.params],
  )
  const defined = new Set(rows.map((r) => r.key_name))
  const unknown = custom.find((m) => !defined.has(m))
  if (unknown)
    throw new ValidationError(`Unknown metric: ${unknown}`, null, "METRIC_UNKNOWN")
}

export const requireKnownMetric = (
  userId: number,
  metric: string,
): Promise<void> => requireKnownMetrics(userId, [metric])
