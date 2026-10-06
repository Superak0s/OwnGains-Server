import { Request, Response, NextFunction } from "express"
import os from "os"
import {
  createHistogram,
  monitorEventLoopDelay,
  type IntervalHistogram,
  type RecordableHistogram,
} from "node:perf_hooks"
import { envBool } from "@/config/env.js"
import { setErrorLogSink } from "@/utils/logger.js"
import { getWsStats } from "@/ws/wsServer.js"

// In-process counters behind GET /api/admin/metrics and the /admin/metrics
// page. Like every other limiter and counter on this box they live in memory,
// reset on restart, and assume one process. Every structure here is
// bounded (fixed-size histograms, capped maps, ring buffers), so memory remains flat
// however long the server runs or whatever a client throws at it.

/** Master switch: off means no collector middleware, no API, no page (404). */
export const metricsEnabled = envBool("METRICS_ENABLED", true)
/** The HTML dashboard alone. The JSON endpoint remains up for the app. */
export const metricsPageEnabled =
  metricsEnabled && envBool("METRICS_PAGE_ENABLED", true)
/** A request at least this slow is added to the slow-request log. */
const SLOW_REQUEST_MS = 1000

// Latencies are recorded in µs into HDR histograms. Two significant figures
// (about 1% error) and a 60s ceiling (the HTTP request timeout) keep each one
// near 20 KB, so even MAX_ROUTES of them stay a few MB.
const MAX_LATENCY_US = 60_000_000
const newHistogram = () =>
  createHistogram({ lowest: 1, highest: MAX_LATENCY_US, figures: 2 })

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

interface RouteStat {
  clientErrors: number
  serverErrors: number
  latency: RecordableHistogram
  byStatus: Map<number, number>
}

interface MinuteBucket {
  clientErrors: number
  serverErrors: number
  rateLimited: number
  latency: RecordableHistogram
}

interface HistoryPoint {
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

interface ErrorEvent {
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

interface SlowRequest {
  at: string
  method: string
  route: string
  path: string
  status: number
  durationMs: number
  reqId: string | null
  user: string | null
}

interface LogError {
  at: string
  message: string
}

const startedAt = new Date()

const newMinute = (): MinuteBucket => ({
  clientErrors: 0,
  serverErrors: 0,
  rateLimited: 0,
  latency: newHistogram(),
})

const totals = {
  inFlight: 0,
  aborted: 0,
  byClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } as Record<string, number>,
  byStatus: new Map<number, number>(),
  byMethod: {} as Record<string, number>,
  latency: newHistogram(),
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

const usToMs = (us: number) => round(us / 1000)

/** The p-th percentile in ms, never above the largest value actually seen. */
const percentile = (h: RecordableHistogram, p: number) =>
  h.count ? usToMs(Math.min(h.percentile(p), h.max)) : null

const latencySummary = (h: RecordableHistogram) => ({
  avg: h.count ? usToMs(h.mean) : null,
  p50: percentile(h, 50),
  p90: percentile(h, 90),
  p95: percentile(h, 95),
  p99: percentile(h, 99),
  max: h.count ? usToMs(h.max) : null,
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
  const us = Math.min(MAX_LATENCY_US, Math.max(1, Math.round(ms * 1000)))
  totals.latency.record(us)
  const cls = `${Math.floor(status / 100)}xx`
  if (cls in totals.byClass) totals.byClass[cls]++
  bump(totals.byStatus, status)
  totals.byMethod[req.method] = (totals.byMethod[req.method] ?? 0) + 1
  const length = Number(res.getHeader("content-length"))
  if (Number.isFinite(length)) totals.bytesOut += length

  minute.latency.record(us)
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
    stat = { clientErrors: 0, serverErrors: 0, latency: newHistogram(), byStatus: new Map() }
    routes.set(label, stat)
  }
  stat.latency.record(us)
  bump(stat.byStatus, status)
  if (status >= 500) stat.serverErrors++
  else if (status >= 400) stat.clientErrors++

  if (status >= 400) recordError(req, res, label, ms)
  if (ms >= SLOW_REQUEST_MS)
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

/** Closes the current minute. Exported so a test needn't wait for the timer. */
export function rollMinute(): void {
  const mem = process.memoryUsage()
  push(
    history,
    {
      at: new Date().toISOString(),
      requests: minute.latency.count,
      clientErrors: minute.clientErrors,
      serverErrors: minute.serverErrors,
      rateLimited: minute.rateLimited,
      avgMs: latencySummary(minute.latency).avg,
      p95Ms: percentile(minute.latency, 95),
      p99Ms: percentile(minute.latency, 99),
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
      const lat = latencySummary(s.latency)
      const count = s.latency.count
      return {
        route,
        count,
        clientErrors: s.clientErrors,
        serverErrors: s.serverErrors,
        errorRate: round(((s.clientErrors + s.serverErrors) / count) * 100, 2),
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
      totalRequests: totals.latency.count,
      inFlight: totals.inFlight,
      aborted: totals.aborted,
      bytesOutMb: mb(totals.bytesOut),
      byStatusClass: { ...totals.byClass },
      byStatus: statusObject(totals.byStatus),
      byMethod: { ...totals.byMethod },
      latencyMs: latencySummary(totals.latency),
      slowThresholdMs: SLOW_REQUEST_MS,
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

/** The boot log line that tells the operator the dashboard exists and where. */
export function metricsBanner(opts: { port: string | number; lanIp?: string; fqdn?: string }): string {
  if (!metricsEnabled) return "📊 Admin metrics are off (METRICS_ENABLED=false)"
  if (!metricsPageEnabled)
    return "📊 Admin metrics: GET /api/admin/metrics with an admin's token (page off: METRICS_PAGE_ENABLED=false)"
  const urls = [
    `http://localhost:${opts.port}`,
    opts.lanIp && `http://${opts.lanIp}:${opts.port}`,
    opts.fqdn && `https://${opts.fqdn.replace(/^https?:\/\//, "")}`,
  ]
  return `📊 Admin metrics dashboard (sign in as an admin): ${urls
    .filter(Boolean)
    .map((u) => `${u}/admin/metrics`)
    .join("  ")}`
}
