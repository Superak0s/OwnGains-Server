import { Request, Response, NextFunction } from "express"
import os from "os"
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks"
import { envBool, envInt } from "@/config/env.js"
import { setErrorLogSink } from "@/utils/logger.js"
import { getWsStats } from "@/ws/wsServer.js"

// In-process counters behind GET /api/admin/metrics and the /admin/metrics
// page. Like every other limiter and counter on this box they live in memory,
// reset on restart, and assume one process. Every structure here is
// bounded (fixed buckets, capped maps, ring buffers), so memory remains flat
// however long the server runs or whatever a client throws at it.

/** Master switch: off means no collector middleware, no API, no page (404). */
export const metricsEnabled = envBool("METRICS_ENABLED", true)
/** The HTML dashboard alone. The JSON endpoint remains up for the app. */
export const metricsPageEnabled =
  metricsEnabled && envBool("METRICS_PAGE_ENABLED", true)
/** A request at least this slow is added to the slow-request log. */
export const slowRequestMs = envInt("METRICS_SLOW_MS", 1000, 1)

// Upper bounds in ms, roughly logarithmic. Fixed buckets instead of stored
// samples: constant memory per route, and a percentile interpolated inside
// its bucket is well within what a dashboard needs.
const BUCKETS_MS = [
  1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000,
  1500, 2000, 3000, 5000, 7500, 10000, 20000, 30000, 60000, Infinity,
]

// Distinct route labels kept. A scanner probing random paths never gets a
// label (only requests that matched a route do), but ids that slip past
// normalisation still could, so the map is capped and the rest are pooled.
const MAX_ROUTES = 200
const OTHER = "(other)"
// Distinct error signatures (status + code + message) kept, same reasoning.
const MAX_ERROR_GROUPS = 300
const MAX_GROUP_ROUTES = 10
const RECENT_SERVER_ERRORS = 100
const RECENT_CLIENT_ERRORS = 200
const RECENT_SLOW = 50
const RECENT_LOG_ERRORS = 100
const MAX_MESSAGE = 500
const MAX_STACK_LINES = 12

// One point per minute, an hour back: enough to see a spike and its shape.
const HISTORY_POINTS = 60
const HISTORY_INTERVAL_MS = 60_000

const newBuckets = () => new Array<number>(BUCKETS_MS.length).fill(0)

interface RouteStat {
  count: number
  clientErrors: number
  serverErrors: number
  totalMs: number
  maxMs: number
  buckets: number[]
  byStatus: Map<number, number>
}

interface MinuteBucket {
  requests: number
  clientErrors: number
  serverErrors: number
  rateLimited: number
  totalMs: number
  maxMs: number
  buckets: number[]
}

export interface HistoryPoint {
  /** Minute end, ISO-8601. */
  at: string
  requests: number
  clientErrors: number
  serverErrors: number
  rateLimited: number
  avgMs: number | null
  p95Ms: number | null
  p99Ms: number | null
  eventLoopP99Ms: number | null
  rssMb: number
  heapUsedMb: number
  cpuPercent: number
  wsSockets: number
}

interface ErrorGroup {
  status: number
  code: string | null
  name: string | null
  message: string
  count: number
  firstSeen: string
  lastSeen: string
  lastReqId: string | null
  routes: Map<string, number>
}

export interface ErrorEvent {
  at: string
  status: number
  method: string
  route: string
  path: string
  code: string | null
  name: string | null
  message: string
  /** The validation details the response included (which fields, and why). */
  details: string | null
  reqId: string | null
  durationMs: number
  /** Whose data the request was about (the trainee, in trainer mode). */
  user: string | null
  /** The trainer acting on `user`'s behalf, if any. */
  trainer: string | null
  ip: string | null
  stack: string | null
}

export interface SlowRequest {
  at: string
  method: string
  route: string
  path: string
  status: number
  durationMs: number
  reqId: string | null
  user: string | null
}

export interface LogError {
  at: string
  message: string
}

const startedAt = new Date()

const newMinute = (): MinuteBucket => ({
  requests: 0,
  clientErrors: 0,
  serverErrors: 0,
  rateLimited: 0,
  totalMs: 0,
  maxMs: 0,
  buckets: newBuckets(),
})

const totals = {
  requests: 0,
  inFlight: 0,
  aborted: 0,
  byClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } as Record<string, number>,
  byStatus: new Map<number, number>(),
  byMethod: {} as Record<string, number>,
  buckets: newBuckets(),
  totalMs: 0,
  maxMs: 0,
  bytesOut: 0,
}
const routes = new Map<string, RouteStat>()
const errorGroups = new Map<string, ErrorGroup>()
const recentServerErrors: ErrorEvent[] = []
const recentClientErrors: ErrorEvent[] = []
const recentSlow: SlowRequest[] = []
const recentLogErrors: LogError[] = []
let logErrorCount = 0
let errorsSince = new Date()
let minute = newMinute()
const history: HistoryPoint[] = []

let historyTimer: ReturnType<typeof setInterval> | null = null
let loopDelay: IntervalHistogram | null = null
let lastCpu = process.cpuUsage()
let lastCpuAt = process.hrtime.bigint()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC = /^\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}/

/** `/api/sessions/42/set?x=1` → `/api/sessions/:id/set`. */
export function routeLabel(method: string, originalUrl: string): string {
  const path = originalUrl.split("?")[0]
  const normalised = path
    .split("/")
    .map((seg) =>
      UUID.test(seg) || NUMERIC.test(seg) ? ":id" : DATE.test(seg) ? ":date" : seg,
    )
    .join("/")
  return `${method} ${normalised.length > 1 ? normalised.replace(/\/$/, "") : normalised}`
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits
const mb = (bytes: number) => round(bytes / 1024 / 1024)
const nsToMs = (ns: number) => round(ns / 1e6, 2)
const clip = (s: string, max = MAX_MESSAGE) => (s.length > max ? `${s.slice(0, max)}…` : s)

function push<T>(ring: T[], item: T, cap: number): void {
  ring.push(item)
  if (ring.length > cap) ring.shift()
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

const bucketIndex = (ms: number) => BUCKETS_MS.findIndex((b) => ms <= b)

/**
 * The p-th percentile from a bucket histogram, interpolated linearly inside
 * the bucket it falls in, and never above the largest value actually seen.
 */
export function percentileOf(buckets: number[], p: number, maxMs: number): number | null {
  const count = buckets.reduce((a, b) => a + b, 0)
  if (count === 0) return null
  const target = Math.max(1, Math.ceil(count * p))
  let seen = 0
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] === 0) continue
    if (seen + buckets[i] >= target) {
      const lower = i === 0 ? 0 : BUCKETS_MS[i - 1]
      const upper = Number.isFinite(BUCKETS_MS[i]) ? BUCKETS_MS[i] : maxMs
      const fraction = (target - seen) / buckets[i]
      return round(Math.min(maxMs, lower + (upper - lower) * fraction))
    }
    seen += buckets[i]
  }
  return round(maxMs)
}

const latencySummary = (buckets: number[], totalMs: number, count: number, maxMs: number) => ({
  avg: count ? round(totalMs / count) : null,
  p50: percentileOf(buckets, 0.5, maxMs),
  p90: percentileOf(buckets, 0.9, maxMs),
  p95: percentileOf(buckets, 0.95, maxMs),
  p99: percentileOf(buckets, 0.99, maxMs),
  max: count ? round(maxMs) : null,
})

/** What went wrong, from the error errorHandler saw or the JSON body sent. */
function describeError(res: Response): {
  code: string | null
  name: string | null
  message: string
  details: string | null
  stack: string | null
} {
  const err = res.locals.error as (Error & { code?: unknown; errno?: unknown; details?: unknown }) | undefined
  const body = res.locals.metricsBody as { error?: unknown; code?: unknown; details?: unknown } | undefined
  const code =
    typeof err?.code === "string"
      ? err.code
      : typeof body?.code === "string"
        ? body.code
        : typeof err?.errno === "number"
          ? `ERRNO_${err.errno}`
          : null
  const message = clip(
    String(err?.message || (typeof body?.error === "string" ? body.error : "") || "(no message)"),
  )
  const name = err ? (err.constructor?.name ?? err.name ?? null) : null
  // Stacks only for 5xx: a 4xx is the caller's mistake, not a code path to fix.
  const stack =
    err?.stack && res.statusCode >= 500
      ? err.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n")
      : null
  const rawDetails = err?.details ?? body?.details
  let details: string | null = null
  if (rawDetails != null)
    try {
      details = clip(typeof rawDetails === "string" ? rawDetails : JSON.stringify(rawDetails))
    } catch {}
  return { code, name, message, details, stack }
}

function recordError(req: Request, res: Response, route: string, ms: number): void {
  const status = res.statusCode
  const { code, name, message, details, stack } = describeError(res)
  const at = new Date().toISOString()

  let key = `${status}|${code ?? name ?? ""}|${message}`
  if (!errorGroups.has(key) && errorGroups.size >= MAX_ERROR_GROUPS) key = OTHER
  let group = errorGroups.get(key)
  if (!group) {
    group =
      key === OTHER
        ? { status: 0, code: null, name: null, message: "(other errors: too many distinct kinds)", count: 0, firstSeen: at, lastSeen: at, lastReqId: null, routes: new Map() }
        : { status, code, name, message, count: 0, firstSeen: at, lastSeen: at, lastReqId: null, routes: new Map() }
    errorGroups.set(key, group)
  }
  group.count++
  group.lastSeen = at
  group.lastReqId = req.reqId ?? null
  if (group.routes.has(route) || group.routes.size < MAX_GROUP_ROUTES) bump(group.routes, route)

  push(
    status >= 500 ? recentServerErrors : recentClientErrors,
    {
      at,
      status,
      method: req.method,
      route,
      path: clip(req.originalUrl.split("?")[0], 200),
      code,
      name,
      message,
      details,
      reqId: req.reqId ?? null,
      durationMs: round(ms),
      // In trainer mode req.user is the trainee whose data was touched and
      // req.trainer the account that actually made the request.
      user: req.user?.username ?? null,
      trainer: req.trainer?.username ?? null,
      ip: req.ip ?? null,
      stack,
    },
    status >= 500 ? RECENT_SERVER_ERRORS : RECENT_CLIENT_ERRORS,
  )
}

function record(req: Request, res: Response, ms: number): void {
  const status = res.statusCode
  const bi = bucketIndex(ms)
  totals.requests++
  totals.totalMs += ms
  totals.maxMs = Math.max(totals.maxMs, ms)
  totals.buckets[bi]++
  const cls = `${Math.floor(status / 100)}xx`
  if (cls in totals.byClass) totals.byClass[cls]++
  bump(totals.byStatus, status)
  totals.byMethod[req.method] = (totals.byMethod[req.method] ?? 0) + 1
  const length = Number(res.getHeader("content-length"))
  if (Number.isFinite(length)) totals.bytesOut += length

  minute.requests++
  minute.totalMs += ms
  minute.maxMs = Math.max(minute.maxMs, ms)
  minute.buckets[bi]++
  if (status === 429) minute.rateLimited++
  if (status >= 500) minute.serverErrors++
  else if (status >= 400) minute.clientErrors++

  // req.route is only set once a route matched, so 404 probes (and requests a
  // router-level middleware such as auth turned away first) pool into one
  // label instead of creating a new one per path tried.
  let label = req.route ? routeLabel(req.method, req.originalUrl) : "(unrouted)"
  if (!routes.has(label) && routes.size >= MAX_ROUTES) label = OTHER
  let stat = routes.get(label)
  if (!stat) {
    stat = { count: 0, clientErrors: 0, serverErrors: 0, totalMs: 0, maxMs: 0, buckets: newBuckets(), byStatus: new Map() }
    routes.set(label, stat)
  }
  stat.count++
  stat.totalMs += ms
  stat.maxMs = Math.max(stat.maxMs, ms)
  stat.buckets[bi]++
  bump(stat.byStatus, status)
  if (status >= 500) stat.serverErrors++
  else if (status >= 400) stat.clientErrors++

  if (status >= 400) recordError(req, res, label, ms)
  if (ms >= slowRequestMs)
    push(
      recentSlow,
      {
        at: new Date().toISOString(),
        method: req.method,
        route: label,
        path: clip(req.originalUrl.split("?")[0], 200),
        status,
        durationMs: round(ms),
        reqId: req.reqId ?? null,
        user: req.trainer?.username ?? req.user?.username ?? null,
      },
      RECENT_SLOW,
    )
}

/**
 * Counts every request except /healthz (a Docker probe every 30s would
 * otherwise dominate the numbers). Mount early, so the time measured covers
 * the limiters and body parsing too.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/healthz") return next()
  const start = process.hrtime.bigint()
  totals.inFlight++

  // Keep the error text and code of anything that answers >= 400 with JSON:
  // the rate limiters, the 404 handler and errorHandler all end up here
  // (res.send of an object goes through res.json too).
  const json = res.json.bind(res)
  res.json = (body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object") res.locals.metricsBody = body
    return json(body)
  }

  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    totals.inFlight--
    // "close" without "finish": the client hung up before the response went
    // out. Counted, but kept out of the status and latency figures.
    if (!res.writableFinished) {
      totals.aborted++
      return
    }
    record(req, res, Number(process.hrtime.bigint() - start) / 1e6)
  }
  res.once("finish", settle)
  res.once("close", settle)
  next()
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) return arg.stack ?? arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

// Every logger.error, request-bound or not: failed cleanup sweeps, DB outages,
// WebSocket errors, unhandled rejections. Hooked at load (it starts no timer),
// so errors logged during boot are kept too.
if (metricsEnabled)
  setErrorLogSink((args) => {
    logErrorCount++
    push(
      recentLogErrors,
      { at: new Date().toISOString(), message: clip(args.map(formatLogArg).join(" "), 2000) },
      RECENT_LOG_ERRORS,
    )
  })

function cpuPercentSinceLast(): number {
  const now = process.hrtime.bigint()
  const cpu = process.cpuUsage(lastCpu)
  const elapsedUs = Number(now - lastCpuAt) / 1000
  lastCpu = process.cpuUsage()
  lastCpuAt = now
  if (elapsedUs <= 0) return 0
  // Of one core: 100 means the event loop's thread was busy the whole minute.
  return round(((cpu.user + cpu.system) / elapsedUs) * 100)
}

function rollMinute(): void {
  const mem = process.memoryUsage()
  push(
    history,
    {
      at: new Date().toISOString(),
      requests: minute.requests,
      clientErrors: minute.clientErrors,
      serverErrors: minute.serverErrors,
      rateLimited: minute.rateLimited,
      avgMs: minute.requests ? round(minute.totalMs / minute.requests) : null,
      p95Ms: percentileOf(minute.buckets, 0.95, minute.maxMs),
      p99Ms: percentileOf(minute.buckets, 0.99, minute.maxMs),
      eventLoopP99Ms: loopDelay && loopDelay.count > 0 ? nsToMs(loopDelay.percentile(99)) : null,
      rssMb: mb(mem.rss),
      heapUsedMb: mb(mem.heapUsed),
      cpuPercent: cpuPercentSinceLast(),
      wsSockets: getWsStats().authenticatedSockets,
    },
    HISTORY_POINTS,
  )
  minute = newMinute()
  loopDelay?.reset()
}

/** Starts the per-minute history and the event-loop delay sampler. Idempotent. */
export function startMetricsCollector(): void {
  if (!metricsEnabled || historyTimer) return
  loopDelay = monitorEventLoopDelay({ resolution: 20 })
  loopDelay.enable()
  lastCpu = process.cpuUsage()
  lastCpuAt = process.hrtime.bigint()
  historyTimer = setInterval(rollMinute, HISTORY_INTERVAL_MS)
  historyTimer.unref()
}

export function stopMetricsCollector(): void {
  if (historyTimer) clearInterval(historyTimer)
  historyTimer = null
  loopDelay?.disable()
  loopDelay = null
}

const statusObject = (m: Map<number, number>) =>
  Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]))

/** Process, host, HTTP and error figures: everything that needs no database. */
export function processSnapshot() {
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  const topRoutes = [...routes.entries()]
    .map(([route, s]) => {
      const lat = latencySummary(s.buckets, s.totalMs, s.count, s.maxMs)
      return {
        route,
        count: s.count,
        clientErrors: s.clientErrors,
        serverErrors: s.serverErrors,
        errorRate: round(((s.clientErrors + s.serverErrors) / s.count) * 100, 2),
        avgMs: lat.avg,
        p50Ms: lat.p50,
        p95Ms: lat.p95,
        p99Ms: lat.p99,
        maxMs: lat.max,
        byStatus: statusObject(s.byStatus),
      }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 100)

  const groups = [...errorGroups.values()]
    .map((g) => ({
      status: g.status,
      code: g.code,
      name: g.name,
      message: g.message,
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      lastReqId: g.lastReqId,
      routes: [...g.routes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([route, count]) => ({ route, count })),
    }))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))

  return {
    process: {
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      pid: process.pid,
      platform: `${process.platform} ${process.arch}`,
      memory: {
        rssMb: mb(mem.rss),
        heapUsedMb: mb(mem.heapUsed),
        heapTotalMb: mb(mem.heapTotal),
        externalMb: mb(mem.external),
        arrayBuffersMb: mb(mem.arrayBuffers),
      },
      cpuSeconds: {
        user: round(cpu.user / 1e6, 2),
        system: round(cpu.system / 1e6, 2),
      },
      eventLoopDelayMs:
        loopDelay && loopDelay.count > 0
          ? {
              mean: nsToMs(loopDelay.mean),
              p50: nsToMs(loopDelay.percentile(50)),
              p99: nsToMs(loopDelay.percentile(99)),
              max: nsToMs(loopDelay.max),
            }
          : null,
    },
    host: {
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      cpus: os.cpus().length,
      loadAverage: os.loadavg().map((n) => round(n, 2)),
      totalMemMb: mb(os.totalmem()),
      freeMemMb: mb(os.freemem()),
      uptimeSeconds: Math.round(os.uptime()),
    },
    http: {
      totalRequests: totals.requests,
      inFlight: totals.inFlight,
      aborted: totals.aborted,
      bytesOutMb: mb(totals.bytesOut),
      byStatusClass: { ...totals.byClass },
      byStatus: statusObject(totals.byStatus),
      byMethod: { ...totals.byMethod },
      latencyMs: latencySummary(totals.buckets, totals.totalMs, totals.requests, totals.maxMs),
      slowThresholdMs: slowRequestMs,
      routes: topRoutes,
      slowRequests: [...recentSlow].reverse(),
    },
    errors: {
      since: errorsSince.toISOString(),
      clientErrors: [...errorGroups.values()].filter((g) => g.status >= 400 && g.status < 500).reduce((s, g) => s + g.count, 0),
      serverErrors: [...errorGroups.values()].filter((g) => g.status >= 500).reduce((s, g) => s + g.count, 0),
      groups,
      recentServer: [...recentServerErrors].reverse(),
      recentClient: [...recentClientErrors].reverse(),
      log: { total: logErrorCount, recent: [...recentLogErrors].reverse() },
    },
    history: [...history],
  }
}

/** Forget the error groups, recent errors, slow requests and logged errors. */
export function clearErrors(): void {
  errorGroups.clear()
  recentServerErrors.length = 0
  recentClientErrors.length = 0
  recentSlow.length = 0
  recentLogErrors.length = 0
  logErrorCount = 0
  errorsSince = new Date()
}

/** Test hook: forget everything counted so far. */
export function resetMetrics(): void {
  totals.requests = 0
  totals.aborted = 0
  totals.totalMs = 0
  totals.maxMs = 0
  totals.bytesOut = 0
  totals.byClass = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }
  totals.byStatus.clear()
  totals.byMethod = {}
  totals.buckets.fill(0)
  routes.clear()
  history.length = 0
  minute = newMinute()
  clearErrors()
}

/** Test hook: close the current minute now instead of waiting for the timer. */
export const rollMinuteForTest = rollMinute

/**
 * The boot banner that tells the operator the dashboard exists and where. A
 * box rather than a line, so it can't scroll past unnoticed among the boot
 * logs. ASCII inside the box: emoji widths vary by terminal and would break
 * the right-hand border.
 */
export function metricsBanner(opts: { port: string | number; lanIp?: string; fqdn?: string }): string {
  if (!metricsEnabled)
    return "📊 Admin metrics are OFF (METRICS_ENABLED=false). Set it to true to get the /admin/metrics dashboard"

  const lines: string[] = []
  if (metricsPageEnabled) {
    lines.push("ADMIN METRICS DASHBOARD IS ON", "")
    lines.push(`  Local:   http://localhost:${opts.port}/admin/metrics`)
    if (opts.lanIp) lines.push(`  LAN:     http://${opts.lanIp}:${opts.port}/admin/metrics`)
    if (opts.fqdn) lines.push(`  Domain:  https://${opts.fqdn.replace(/^https?:\/\//, "")}/admin/metrics`)
    lines.push("", "Sign in with an ADMIN account (the app's username + password).")
  } else {
    lines.push("ADMIN METRICS ARE ON (web page off: METRICS_PAGE_ENABLED=false)")
  }
  lines.push(
    "App / scripts: GET /api/admin/metrics with an admin's Bearer token",
    `Slow-request threshold: ${slowRequestMs} ms (METRICS_SLOW_MS)`,
    "Turn off: METRICS_ENABLED=false  |  page only: METRICS_PAGE_ENABLED=false",
  )

  const width = Math.max(...lines.map((l) => l.length)) + 4
  const bar = "═".repeat(width)
  return [
    `╔${bar}╗`,
    ...lines.map((l) => `║  ${l.padEnd(width - 2)}║`),
    `╚${bar}╝`,
  ].join("\n")
}
