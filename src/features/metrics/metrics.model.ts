import type { RowDataPacket } from "mysql2/promise"
import { pool } from "@/config/database.js"

// The database half of the admin metrics. Every figure is a plain COUNT or an
// information_schema read. On one small box a full scan of `workouts`
// is milliseconds, and the result is cached (see DB_CACHE_MS) so a dashboard
// left open refreshing every few seconds costs one run per window, not one
// per viewer per refresh.

const DB_CACHE_MS = 15_000

export interface AppCounts {
  users: { total: number; admins: number; suspended: number; new7d: number; new30d: number }
  activeUsers: { day: number; week: number; month: number }
  workouts: { total: number; inProgress: number; last24h: number; last7d: number }
  sets: { total: number }
  programs: number
  friendships: { accepted: number; pending: number }
  jointSessionsActive: number
  reports: { total: number; last7d: number }
  photos: { count: number; totalMb: number }
  refreshTokensActive: number
  idempotencyKeys: number
}

export interface DbSnapshot {
  collectedAt: string
  app: AppCounts | null
  server: {
    version: string | null
    /** Round trip of a trivial query through the pool, as the app sees it. */
    pingMs: number
    status: Record<string, number>
  } | null
  size: {
    totalMb: number
    tables: { name: string; rows: number; dataMb: number; indexMb: number }[]
  } | null
  errors: string[]
}

const n = (v: unknown) => Number(v ?? 0)
const mb = (bytes: unknown) => Math.round((n(bytes) / 1024 / 1024) * 100) / 100

async function appCounts(): Promise<AppCounts> {
  // One round trip: scalar subqueries, each on its own table.
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE demo_owner_id IS NULL)                 AS users_total,
      (SELECT COUNT(*) FROM users WHERE is_admin = 1)                           AS users_admins,
      (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL AND demo_owner_id IS NULL) AS users_suspended,
      (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL 7 DAY AND demo_owner_id IS NULL)  AS users_new7d,
      (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL 30 DAY AND demo_owner_id IS NULL) AS users_new30d,
      (SELECT COUNT(DISTINCT user_id) FROM workouts WHERE start_time >= NOW() - INTERVAL 1 DAY)  AS active_day,
      (SELECT COUNT(DISTINCT user_id) FROM workouts WHERE start_time >= NOW() - INTERVAL 7 DAY)  AS active_week,
      (SELECT COUNT(DISTINCT user_id) FROM workouts WHERE start_time >= NOW() - INTERVAL 30 DAY) AS active_month,
      (SELECT COUNT(*) FROM workouts)                                           AS workouts_total,
      (SELECT COUNT(*) FROM workouts WHERE end_time IS NULL)                    AS workouts_open,
      (SELECT COUNT(*) FROM workouts WHERE start_time >= NOW() - INTERVAL 1 DAY) AS workouts_24h,
      (SELECT COUNT(*) FROM workouts WHERE start_time >= NOW() - INTERVAL 7 DAY) AS workouts_7d,
      (SELECT COUNT(*) FROM workout_sets)                                       AS sets_total,
      (SELECT COUNT(*) FROM programs)                                           AS programs,
      (SELECT COUNT(*) FROM friendships WHERE status = 'accepted')              AS friends_accepted,
      (SELECT COUNT(*) FROM friendships WHERE status = 'pending')               AS friends_pending,
      (SELECT COUNT(*) FROM joint_sessions WHERE status = 'active')             AS joint_active,
      (SELECT COUNT(*) FROM user_reports)                                       AS reports_total,
      (SELECT COUNT(*) FROM user_reports WHERE created_at >= NOW() - INTERVAL 7 DAY) AS reports_7d,
      (SELECT COUNT(*) FROM progress_photos)                                    AS photos_count,
      (SELECT COALESCE(SUM(file_size), 0) FROM progress_photos)                 AS photos_bytes,
      (SELECT COUNT(*) FROM refresh_tokens
        WHERE revoked_at IS NULL AND used_at IS NULL AND expires_at > NOW())    AS refresh_active,
      (SELECT COUNT(*) FROM idempotency_keys)                                   AS idem_keys
  `)
  const r = rows[0]
  return {
    users: {
      total: n(r.users_total),
      admins: n(r.users_admins),
      suspended: n(r.users_suspended),
      new7d: n(r.users_new7d),
      new30d: n(r.users_new30d),
    },
    activeUsers: { day: n(r.active_day), week: n(r.active_week), month: n(r.active_month) },
    workouts: {
      total: n(r.workouts_total),
      inProgress: n(r.workouts_open),
      last24h: n(r.workouts_24h),
      last7d: n(r.workouts_7d),
    },
    sets: { total: n(r.sets_total) },
    programs: n(r.programs),
    friendships: { accepted: n(r.friends_accepted), pending: n(r.friends_pending) },
    jointSessionsActive: n(r.joint_active),
    reports: { total: n(r.reports_total), last7d: n(r.reports_7d) },
    photos: { count: n(r.photos_count), totalMb: mb(r.photos_bytes) },
    refreshTokensActive: n(r.refresh_active),
    idempotencyKeys: n(r.idem_keys),
  }
}

// Read one by one with SHOW GLOBAL STATUS rather than performance_schema,
// which a restricted MySQL user (or MariaDB without it enabled) can't read.
const STATUS_VARS = [
  "Uptime",
  "Threads_connected",
  "Threads_running",
  "Max_used_connections",
  "Questions",
  "Slow_queries",
  "Aborted_connects",
  "Aborted_clients",
  "Innodb_buffer_pool_pages_total",
  "Innodb_buffer_pool_pages_free",
  "Innodb_row_lock_waits",
  "Innodb_row_lock_time_avg",
  "Innodb_deadlocks",
  "Created_tmp_disk_tables",
  "Com_select",
  "Com_insert",
  "Com_update",
  "Com_delete",
  "Bytes_received",
  "Bytes_sent",
]

async function serverInfo(): Promise<NonNullable<DbSnapshot["server"]>> {
  const t0 = process.hrtime.bigint()
  const [version] = await pool.query<RowDataPacket[]>("SELECT VERSION() AS v")
  const pingMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100
  // Absent variables (Innodb_deadlocks is MariaDB-only) are simply missing.
  const [status] = await pool.query<RowDataPacket[]>(
    "SHOW GLOBAL STATUS WHERE Variable_name IN (?)",
    [STATUS_VARS],
  )
  return {
    version: version[0]?.v ?? null,
    pingMs,
    status: Object.fromEntries(status.map((r) => [r.Variable_name, n(r.Value)])),
  }
}

async function tableSizes(): Promise<NonNullable<DbSnapshot["size"]>> {
  // table_rows is InnoDB's estimate, which is what makes this cheap.
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT table_name AS name, table_rows AS rows_est,
           data_length AS data_bytes, index_length AS index_bytes
      FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
     ORDER BY data_length + index_length DESC
  `)
  const tables = rows.map((r) => ({
    name: String(r.name),
    rows: n(r.rows_est),
    dataMb: mb(r.data_bytes),
    indexMb: mb(r.index_bytes),
  }))
  return {
    totalMb: Math.round(tables.reduce((s, t) => s + t.dataMb + t.indexMb, 0) * 100) / 100,
    tables,
  }
}

async function collect(): Promise<DbSnapshot> {
  // Settled independently: a MySQL user without SHOW STATUS rights still gets
  // the app counts, and the page says which part failed.
  const [app, server, size] = await Promise.allSettled([appCounts(), serverInfo(), tableSizes()])
  const errors: string[] = []
  const value = <T>(r: PromiseSettledResult<T>, what: string): T | null => {
    if (r.status === "fulfilled") return r.value
    errors.push(`${what}: ${(r.reason as Error)?.message ?? String(r.reason)}`)
    return null
  }
  return {
    collectedAt: new Date().toISOString(),
    app: value(app, "app counts"),
    server: value(server, "server status"),
    size: value(size, "table sizes"),
    errors,
  }
}

let cached: { at: number; snapshot: DbSnapshot } | null = null
let pending: Promise<DbSnapshot> | null = null

/** The DB figures, at most DB_CACHE_MS old. Concurrent callers share one run. */
export async function getDbSnapshot(): Promise<DbSnapshot> {
  if (cached && Date.now() - cached.at < DB_CACHE_MS) return cached.snapshot
  pending ??= collect()
    .then((snapshot) => {
      cached = { at: Date.now(), snapshot }
      return snapshot
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Test hook. */
export function clearDbSnapshotCache(): void {
  cached = null
}

/**
 * Connection-pool occupancy. mysql2 exposes no public API for it, so this
 * reads the core pool's internals defensively and reports nulls if a future
 * mysql2 renames them rather than throwing.
 */
export function poolStats() {
  type Core = {
    config?: { connectionLimit?: number; queueLimit?: number }
    _allConnections?: { length: number }
    _freeConnections?: { length: number }
    _connectionQueue?: { length: number }
  }
  const core = (pool as unknown as { pool?: Core }).pool
  const all = core?._allConnections?.length
  const free = core?._freeConnections?.length
  return {
    limit: core?.config?.connectionLimit ?? null,
    queueLimit: core?.config?.queueLimit ?? null,
    open: all ?? null,
    inUse: all != null && free != null ? all - free : null,
    queued: core?._connectionQueue?.length ?? null,
  }
}
