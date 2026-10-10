import { Request, Response, NextFunction } from "express"
import os from "node:os"
import {
  createHistogram,
  monitorEventLoopDelay,
  type IntervalHistogram,
  type RecordableHistogram,
} from "node:perf_hooks"
import { envBool } from "@/config/env.js"
import { logger, setErrorLogSink } from "@/utils/logger.js"
import { getWsStats } from "@/ws/wsServer.js"
import { checkBotTraffic, checkHealth, healthLimits, isSuspicious, noteSuspicious } from "./metrics.alerts.js"
import {
  deleteEvents,
  loadEvents,
  loadHistoryRows,
  pruneEvents,
  pruneHistory,
  saveEvents,
  saveHistoryRows,
} from "./metrics.model.js"

// In-process counters behind GET /api/admin/metrics and the /admin/metrics
// page. They assume one process. Once started, the per-minute history
// (metrics_history, rolled up to hours past a day) and the error, slow-request
// and log events (metrics_events) are also saved, kept 30 days, and the
// history is reloaded on boot. Windows older than what memory holds read the
// events back from the database. Every structure here is bounded (fixed-size
// histograms, capped maps, ring buffers), so memory remains flat however long
// the server runs or whatever a client throws at it.

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
const MAX_GROUP_ROUTES = 10
// Events kept for the error lists and error kinds. Error kinds are grouped
// from these per request, so a window older than the oldest kept event shows
// only part of it (the page says so). The counts come from the per-minute
// buckets below and are exact whatever the window.
const RECENT_SERVER_ERRORS = 500
const RECENT_CLIENT_ERRORS = 2000
const RECENT_SLOW = 500
const RECENT_LOG_ERRORS = 300
// Newest events of each list sent per response, so a 15s refresh stays small.
const MAX_SENT_EVENTS = 200
const MAX_MESSAGE = 500
const MAX_STACK_LINES = 12

// History: one record per minute for the last day, then one per clock hour
// for 30 days. Events in the database: 30 days, at most EVENTS_KEPT rows.
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const RETENTION_MS = 30 * DAY_MS
const EVENTS_KEPT = 100_000
// Events waiting for the next minute's save. Past this, a flood's extra events
// stay in memory only. ponytail: drops silently, count them if it matters.
const MAX_PENDING_EVENTS = 2000
// A minute's latency as counts in log-spaced buckets 5% wide (a value is
// reported as its bucket's middle, so within 2.5%). Unlike an HDR histogram
// they add up across minutes and fit in a database row.
const LOG_GROWTH = Math.log(1.05)
// Longer windows are drawn in coarser buckets so a chart has at most this many.
const MAX_CHART_POINTS = 120

/** Selectable windows in minutes. `all` means since restart. */
export const WINDOWS = {
  "15m": 15,
  "1h": 60,
  "6h": 360,
  "24h": 1440,
  "7d": 10_080,
  "30d": 43_200,
  all: null,
} as const
export type WindowKey = keyof typeof WINDOWS
/** A preset, or a custom range in epoch ms. */
export type Window = WindowKey | { fromMs: number; toMs: number }

interface RouteStat {
  clientErrors: number
  serverErrors: number
  latency: RecordableHistogram
  byStatus: Map<number, number>
}

interface Latency {
  n: number
  sumUs: number
  maxUs: number
  /** Bucket index → count. */
  b: Record<string, number>
}

interface MinuteBucket {
  latency: Latency
  byStatus: Map<number, number>
}

/** A closed minute or hour. */
interface Period extends MinuteBucket {
  /** Period end, epoch ms. */
  atMs: number
  point: HistoryPoint
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

const newLatency = (): Latency => ({ n: 0, sumUs: 0, maxUs: 0, b: {} })
const newMinute = (): MinuteBucket => ({ latency: newLatency(), byStatus: new Map() })

const totals = {
  inFlight: 0,
  aborted: 0,
  byStatus: new Map<number, number>(),
  byMethod: {} as Record<string, number>,
  latency: newHistogram(),
  bytesOut: 0,
}
const routes = new Map<string, RouteStat>()
const recentServerErrors: ErrorEvent[] = []
const recentClientErrors: ErrorEvent[] = []
const recentSlow: SlowRequest[] = []
const recentLogErrors: LogError[] = []
let logErrorCount = 0
let errorsSince = new Date()
let minute = newMinute()
/** Closed minutes, oldest first, until their whole hour is a day old. */
const minutes: Period[] = []
/** Closed hours, oldest first, 30 days. */
const hours: Period[] = []

// Indexed by metrics_events.kind.
const SOURCES: { ring: { at: string }[]; cap: number }[] = [
  { ring: recentServerErrors, cap: RECENT_SERVER_ERRORS },
  { ring: recentClientErrors, cap: RECENT_CLIENT_ERRORS },
  { ring: recentSlow, cap: RECENT_SLOW },
  { ring: recentLogErrors, cap: RECENT_LOG_ERRORS },
]
const KIND = { server: 0, client: 1, slow: 2, log: 3 } as const
let pendingEvents: { kind: number; atMs: number; data: string }[] = []

let started = false
let historyTimer: ReturnType<typeof setInterval> | null = null
let loopDelay: IntervalHistogram | null = null
let lastCpu = process.cpuUsage()
let lastCpuAt = process.hrtime.bigint()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC = /^\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}/

/**
 * `/api/sessions/42/set?x=1` → `/api/sessions/:id/set`. With the matched
 * route's pattern, its parameters replace the URL's last segments, so free-text
 * values (`/split/:split`) can't mint a new label per value a client sends.
 */
export function routeLabel(method: string, originalUrl: string, routePath?: unknown): string {
  const segs = originalUrl
    .split("?")[0]
    .split("/")
    .map((seg) => {
      if (UUID.test(seg) || NUMERIC.test(seg)) return ":id"
      return DATE.test(seg) ? ":date" : seg
    })
  if (segs.length > 1 && segs.at(-1) === "") segs.pop()
  // Only string patterns: the router's base path isn't known here, so the
  // pattern is lined up against the end of the URL.
  if (typeof routePath === "string") {
    const pattern = routePath.split("/").filter(Boolean)
    const offset = segs.length - pattern.length
    if (offset >= 1)
      pattern.forEach((p, i) => {
        if (p.startsWith(":")) segs[offset + i] = p
      })
  }
  const path = segs.join("/")
  return `${method} ${path || "/"}`
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits
const mb = (bytes: number) => round(bytes / 1024 / 1024)
const nsToMs = (ns: number) => round(ns / 1e6, 2)
const clip = (s: string, max = MAX_MESSAGE) => (s.length > max ? `${s.slice(0, max)}…` : s)

function push<T>(ring: T[], item: T, cap: number): void {
  ring.push(item)
  if (ring.length > cap) ring.shift()
}

/**
 * Adds an event to its ring and, once started, to the next save. The client
 * IP stays in memory only and is never written to the database.
 */
function keep<T extends { at: string }>(kind: number, item: T): void {
  const { ring, cap } = SOURCES[kind]
  push(ring, item, cap)
  if (started && pendingEvents.length < MAX_PENDING_EVENTS)
    pendingEvents.push({
      kind,
      atMs: Date.parse(item.at),
      data: JSON.stringify(item, (k, v) => (k === "ip" ? null : v)),
    })
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

const usToMs = (us: number) => round(us / 1000)

/** The p-th percentile in ms, never above the largest value actually seen. */
const percentile = (h: RecordableHistogram, p: number) =>
  h.count ? usToMs(Math.min(h.percentile(p), h.max)) : null

function addLatency(l: Latency, us: number): void {
  l.n++
  l.sumUs += us
  l.maxUs = Math.max(l.maxUs, us)
  const i = Math.floor(Math.log(us) / LOG_GROWTH)
  l.b[i] = (l.b[i] ?? 0) + 1
}

function mergeLatency(into: Latency, from: Latency): void {
  into.n += from.n
  into.sumUs += from.sumUs
  into.maxUs = Math.max(into.maxUs, from.maxUs)
  for (const i in from.b) into.b[i] = (into.b[i] ?? 0) + from.b[i]
}

function bucketPercentile(l: Latency, p: number): number | null {
  if (!l.n) return null
  const target = Math.max(1, Math.ceil((l.n * p) / 100))
  let seen = 0
  for (const i of Object.keys(l.b).map(Number).sort((a, b) => a - b)) {
    seen += l.b[i]
    if (seen >= target) return usToMs(Math.min(Math.exp((i + 0.5) * LOG_GROWTH), l.maxUs))
  }
  return usToMs(l.maxUs)
}

const bucketSummary = (l: Latency) => ({
  avg: l.n ? usToMs(l.sumUs / l.n) : null,
  p50: bucketPercentile(l, 50),
  p90: bucketPercentile(l, 90),
  p95: bucketPercentile(l, 95),
  p99: bucketPercentile(l, 99),
  max: l.n ? usToMs(l.maxUs) : null,
})

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
  let code: string | null = null
  if (typeof err?.code === "string") code = err.code
  else if (typeof body?.code === "string") code = body.code
  else if (typeof err?.errno === "number") code = `ERRNO_${err.errno}`
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
  keep(
    status >= 500 ? KIND.server : KIND.client,
    {
      at: new Date().toISOString(),
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
  )
}

function record(req: Request, res: Response, ms: number): void {
  const status = res.statusCode
  const us = Math.min(MAX_LATENCY_US, Math.max(1, Math.round(ms * 1000)))
  totals.latency.record(us)
  bump(totals.byStatus, status)
  totals.byMethod[req.method] = (totals.byMethod[req.method] ?? 0) + 1
  const length = Number(res.getHeader("content-length"))
  if (Number.isFinite(length)) totals.bytesOut += length

  addLatency(minute.latency, us)
  bump(minute.byStatus, status)

  // req.route is only set once a route matched, so 404 probes (and requests a
  // router-level middleware such as auth turned away first) pool into one
  // label instead of creating a new one per path tried.
  let label = req.route ? routeLabel(req.method, req.originalUrl, req.route.path) : "(unrouted)"
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
  if (isSuspicious(status, Boolean(req.route)))
    noteSuspicious(req.ip, status, clip(req.originalUrl.split("?")[0], 200))
  if (ms >= SLOW_REQUEST_MS)
    keep(
      KIND.slow,
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
    keep(
      KIND.log,
      { at: new Date().toISOString(), message: clip(args.map(formatLogArg).join(" "), 2000) },
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

const hourEnd = (ms: number) => Math.ceil(ms / HOUR_MS) * HOUR_MS

/**
 * One chart point from several. Counts add up, latency and event-loop figures
 * keep the worst, and gauges are averaged.
 */
function mergePoints(c: HistoryPoint[]): HistoryPoint {
  if (c.length === 1) return c[0]
  const sum = (f: (p: HistoryPoint) => number) => c.reduce((t, p) => t + f(p), 0)
  const worst = (f: (p: HistoryPoint) => number | null) => {
    const v = c.map(f).filter((x): x is number => x != null)
    return v.length ? Math.max(...v) : null
  }
  const requests = sum((p) => p.requests)
  return {
    at: c[c.length - 1].at,
    requests,
    clientErrors: sum((p) => p.clientErrors),
    serverErrors: sum((p) => p.serverErrors),
    rateLimited: sum((p) => p.rateLimited),
    avgMs: requests ? round(sum((p) => (p.avgMs ?? 0) * p.requests) / requests) : null,
    p95Ms: worst((p) => p.p95Ms),
    p99Ms: worst((p) => p.p99Ms),
    eventLoopP99Ms: worst((p) => p.eventLoopP99Ms),
    rssMb: round(sum((p) => p.rssMb) / c.length),
    heapUsedMb: round(sum((p) => p.heapUsedMb) / c.length),
    cpuPercent: round(sum((p) => p.cpuPercent) / c.length),
    wsSockets: round(sum((p) => p.wsSockets) / c.length),
  }
}

function addBucket(into: MinuteBucket, from: MinuteBucket): void {
  for (const [s, n] of from.byStatus) into.byStatus.set(s, (into.byStatus.get(s) ?? 0) + n)
  mergeLatency(into.latency, from.latency)
}

/**
 * Moves every minute whose whole clock hour is over a day old into one hour
 * record, and drops hours past retention. Returns the new hours.
 */
function age(now: number): Period[] {
  const done: Period[] = []
  while (minutes.length && hourEnd(minutes[0].atMs) <= now - DAY_MS) {
    const end = hourEnd(minutes[0].atMs)
    let i = 0
    while (i < minutes.length && hourEnd(minutes[i].atMs) === end) i++
    const group = minutes.splice(0, i)
    const hour: Period = { atMs: end, ...newMinute(), point: group[0].point }
    for (const m of group) addBucket(hour, m)
    const lat = bucketSummary(hour.latency)
    hour.point = {
      ...mergePoints(group.map((m) => m.point)),
      at: new Date(end).toISOString(),
      avgMs: lat.avg,
      p95Ms: lat.p95,
      p99Ms: lat.p99,
    }
    hours.push(hour)
    done.push(hour)
  }
  while (hours.length && hours[0].atMs <= now - RETENTION_MS) hours.shift()
  return done
}

/** Closes the current minute. Exported so a test needn't wait for the timer. */
export function rollMinute(): { minute: Period; hours: Period[] } {
  const mem = process.memoryUsage()
  const now = Date.now()
  const classes = byClass(minute.byStatus)
  const lat = bucketSummary(minute.latency)
  const closed: Period = {
    atMs: now,
    ...minute,
    point: {
      at: new Date(now).toISOString(),
      requests: minute.latency.n,
      clientErrors: classes["4xx"],
      serverErrors: classes["5xx"],
      rateLimited: minute.byStatus.get(429) ?? 0,
      avgMs: lat.avg,
      p95Ms: lat.p95,
      p99Ms: lat.p99,
      eventLoopP99Ms: loopDelay && loopDelay.count > 0 ? nsToMs(loopDelay.percentile(99)) : null,
      rssMb: mb(mem.rss),
      heapUsedMb: mb(mem.heapUsed),
      cpuPercent: cpuPercentSinceLast(),
      wsSockets: getWsStats().authenticatedSockets,
    },
  }
  minutes.push(closed)
  minute = newMinute()
  loopDelay?.reset()
  return { minute: closed, hours: age(now) }
}

const toRow = (spanMin: number) => (p: Period) => ({
  spanMin,
  atMs: p.atMs,
  data: JSON.stringify({ byStatus: Object.fromEntries(p.byStatus), latency: p.latency, point: p.point }),
})

function fromRow(r: { atMs: number; data: string }): Period {
  const d = JSON.parse(r.data) as { byStatus: Record<string, number>; latency: Latency; point: HistoryPoint }
  return {
    atMs: r.atMs,
    byStatus: new Map(Object.entries(d.byStatus).map(([s, n]) => [Number(s), n])),
    latency: d.latency,
    point: d.point,
  }
}

async function flushEvents(): Promise<void> {
  if (!pendingEvents.length) return
  const rows = pendingEvents
  pendingEvents = []
  await saveEvents(rows)
}

/** Saves closed periods and queued events, then trims both tables. */
async function persist(closed: Period[], newHours: Period[]): Promise<void> {
  try {
    await saveHistoryRows([...closed.map(toRow(1)), ...newHours.map(toRow(60))])
    if (newHours.length) await pruneHistory(newHours.at(-1)!.atMs, Date.now() - RETENTION_MS)
    await flushEvents()
    await pruneEvents(Date.now() - RETENTION_MS, EVENTS_KEPT)
  } catch (err) {
    // warn, not error: logger.error feeds the event list this just failed to save.
    logger.warn("Saving metrics failed:", (err as Error).message)
  }
}

async function tick(): Promise<void> {
  const { minute: closed, hours: newHours } = rollMinute()
  await persist([closed], newHours)
  await checkBotTraffic()
  const now = Date.now()
  const t = windowTraffic(now - healthLimits.windowMinutes * MINUTE_MS, now, false)
  const requests = [...t.byStatus.values()].reduce((a, b) => a + b, 0)
  await checkHealth({ requests, serverErrors: byClass(t.byStatus)["5xx"], p95Ms: t.latency.p95, p99Ms: t.latency.p99 })
}

/** Reloads the saved history, so charts and window counts outlast a restart. */
async function loadHistory(): Promise<void> {
  const now = Date.now()
  const rows = await loadHistoryRows(now - RETENTION_MS)
  const savedHours = rows.filter((r) => r.spanMin === 60).map(fromRow)
  const lastHour = savedHours.at(-1)?.atMs ?? 0
  hours.unshift(...savedHours)
  minutes.unshift(...rows.filter((r) => r.spanMin === 1 && hourEnd(r.atMs) > lastHour).map(fromRow))
  minutes.sort((a, b) => a.atMs - b.atMs)
  await persist([], age(now))
}

/**
 * Starts the per-minute history, the event-loop delay sampler and saving to
 * the database. Idempotent. Resolves once the saved history is loaded.
 */
export async function startMetricsCollector(): Promise<void> {
  if (!metricsEnabled || started) return
  started = true
  loopDelay = monitorEventLoopDelay({ resolution: 20 })
  loopDelay.enable()
  lastCpu = process.cpuUsage()
  lastCpuAt = process.hrtime.bigint()
  try {
    await loadHistory()
  } catch (err) {
    logger.warn("Loading saved metrics failed:", (err as Error).message)
  }
  if (!started) return
  historyTimer = setInterval(() => void tick(), MINUTE_MS)
  historyTimer.unref()
}

/** Stops the timers and saves the minute in progress and the queued events. */
export async function stopMetricsCollector(): Promise<void> {
  if (!started) return
  started = false
  if (historyTimer) clearInterval(historyTimer)
  historyTimer = null
  const { minute: closed, hours: newHours } = rollMinute()
  loopDelay?.disable()
  loopDelay = null
  await persist([closed], newHours)
}

const statusObject = (m: Map<number, number>) =>
  Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]))

function byClass(m: Map<number, number>): Record<"2xx" | "3xx" | "4xx" | "5xx", number> {
  const out = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }
  for (const [status, n] of m) {
    const cls = `${Math.floor(status / 100)}xx`
    if (cls in out) out[cls as keyof typeof out] += n
  }
  return out
}

/** Closed minutes and hours that end in (fromMs, toMs]. Past a day, to the hour. */
const periodsIn = (fromMs: number, toMs: number) =>
  hours.concat(minutes).filter((p) => p.atMs > fromMs && p.atMs <= toMs)

/** Status counts and latency for the range, plus the open minute when `live`. */
function windowTraffic(fromMs: number, toMs: number, live: boolean) {
  const sum: MinuteBucket = newMinute()
  for (const p of periodsIn(fromMs, toMs)) addBucket(sum, p)
  if (live) addBucket(sum, minute)
  return { byStatus: sum.byStatus, latency: bucketSummary(sum.latency) }
}

/**
 * The range's periods as chart points, merged into buckets aligned to the
 * clock (so they don't shift between refreshes) when the range is long.
 * Buckets are whole hours once the range reaches past the minute records.
 */
function chartHistory(fromMs: number, toMs: number) {
  const span = Math.max(1, Math.ceil((toMs - fromMs) / MINUTE_MS))
  let size = Math.ceil(span / MAX_CHART_POINTS)
  if (fromMs < Date.now() - DAY_MS) size = Math.ceil(size / 60) * 60
  const chunks = new Map<number, HistoryPoint[]>()
  for (const p of periodsIn(fromMs, toMs)) {
    const key = Math.floor((p.atMs - 1) / (size * MINUTE_MS))
    chunks.get(key)?.push(p.point) ?? chunks.set(key, [p.point])
  }
  // Aligned buckets can straddle the range's edge by one: drop the oldest.
  const slots = Math.ceil(span / size)
  return { bucketMinutes: size, slots, points: [...chunks.values()].map(mergePoints).slice(-slots) }
}

/** Error kinds (status + code + message) among the given events. */
function groupErrors(events: ErrorEvent[]) {
  const groups = new Map<string, { first: ErrorEvent; last: ErrorEvent; count: number; routes: Map<string, number> }>()
  for (const ev of events) {
    const key = `${ev.status}|${ev.code ?? ev.name ?? ""}|${ev.message}`
    const g = groups.get(key)
    if (!g) groups.set(key, { first: ev, last: ev, count: 1, routes: new Map([[ev.route, 1]]) })
    else {
      g.count++
      if (ev.at < g.first.at) g.first = ev
      if (ev.at >= g.last.at) g.last = ev
      bump(g.routes, ev.route)
    }
  }
  return [...groups.values()]
    .map(({ first, last, count, routes: r }) => ({
      status: last.status,
      code: last.code,
      name: last.name,
      message: last.message,
      count,
      firstSeen: first.at,
      lastSeen: last.at,
      lastReqId: last.reqId,
      routes: [...r.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_GROUP_ROUTES)
        .map(([route, n]) => ({ route, count: n })),
    }))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString())

interface EventLists {
  server: ErrorEvent[]
  client: ErrorEvent[]
  slow: SlowRequest[]
  log: LogError[]
  /** Set when a list hit its cap inside the range: lists and kinds start here. */
  listsFrom: string | null
}

/** The rings' events in (fromMs, toMs], newest first. */
function memoryLists(fromMs: number | null, toMs: number): EventLists {
  const from = iso(fromMs)
  const to = iso(toMs)!
  const pick = <T extends { at: string }>(ring: T[]) =>
    ring.filter((e) => (!from || e.at > from) && e.at <= to).reverse()
  // A full ring has dropped older events. If its oldest is inside the range,
  // the lists and error kinds start there, not at the range's edge.
  const cut = [
    recentServerErrors.length >= RECENT_SERVER_ERRORS ? recentServerErrors[0].at : "",
    recentClientErrors.length >= RECENT_CLIENT_ERRORS ? recentClientErrors[0].at : "",
  ].sort().at(-1)
  return {
    server: pick(recentServerErrors),
    client: pick(recentClientErrors),
    slow: pick(recentSlow),
    log: pick(recentLogErrors),
    listsFrom: cut && (!from || cut > from) ? cut : null,
  }
}

/**
 * The range's events: from memory when it holds the whole range (or the
 * collector isn't saving), otherwise from metrics_events, each list capped
 * at its ring's size.
 */
async function eventLists(fromMs: number | null, toMs: number): Promise<EventLists> {
  const memFrom = Math.max(
    startedAt.getTime(),
    ...SOURCES.map((s) => (s.ring.length >= s.cap ? Date.parse(s.ring[0].at) : 0)),
  )
  if (fromMs == null || fromMs >= memFrom || !started) return memoryLists(fromMs, toMs)
  try {
    await flushEvents()
    const lists = await Promise.all(
      SOURCES.map(async (s, kind) => (await loadEvents(kind, fromMs, toMs, s.cap)).map((d) => JSON.parse(d))),
    )
    const cut = [KIND.server, KIND.client]
      .filter((k) => lists[k].length >= SOURCES[k].cap)
      .map((k) => lists[k].at(-1).at as string)
      .sort()
      .at(-1)
    return { server: lists[0], client: lists[1], slow: lists[2], log: lists[3], listsFrom: cut ?? null }
  } catch (err) {
    logger.warn("Reading saved metrics events failed:", (err as Error).message)
    return memoryLists(fromMs, toMs)
  }
}

/**
 * Process, host, HTTP and error figures: everything but the database counts.
 * Traffic, latency, errors and slow requests cover `window`. Routes, methods,
 * bytes sent and aborted requests are since restart.
 */
export async function processSnapshot(window: Window = "1h") {
  const now = Date.now()
  const key = typeof window === "string" ? window : "custom"
  const toMs = typeof window === "string" ? now : Math.min(window.toMs, now)
  let fromMs: number | null = null
  if (typeof window !== "string") fromMs = window.fromMs
  else if (WINDOWS[window] != null) fromMs = now - WINDOWS[window] * MINUTE_MS
  const traffic =
    fromMs == null
      ? { byStatus: totals.byStatus, latency: latencySummary(totals.latency) }
      : windowTraffic(fromMs, toMs, toMs >= now)
  const classes = byClass(traffic.byStatus)
  const lists = await eventLists(fromMs, toMs)
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

  return {
    window: {
      key,
      minutes: fromMs == null ? null : Math.round((toMs - fromMs) / MINUTE_MS),
      from: iso(fromMs),
      to: iso(toMs),
      // The oldest kept data. Events are saved alongside the history, so they
      // never reach further back.
      dataFrom: iso(
        Math.min(startedAt.getTime(), hours[0] ? hours[0].atMs - HOUR_MS : (minutes[0]?.atMs ?? Infinity)),
      ),
    },
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
      totalRequests: [...traffic.byStatus.values()].reduce((s, n) => s + n, 0),
      inFlight: totals.inFlight,
      aborted: totals.aborted,
      bytesOutMb: mb(totals.bytesOut),
      byStatusClass: classes,
      byStatus: statusObject(traffic.byStatus),
      byMethod: { ...totals.byMethod },
      latencyMs: traffic.latency,
      slowThresholdMs: SLOW_REQUEST_MS,
      routes: topRoutes,
      slowRequests: lists.slow.slice(0, MAX_SENT_EVENTS),
    },
    errors: {
      since: errorsSince.toISOString(),
      listsFrom: lists.listsFrom,
      clientErrors: classes["4xx"],
      serverErrors: classes["5xx"],
      groups: groupErrors(lists.server.concat(lists.client)),
      recentServer: lists.server.slice(0, MAX_SENT_EVENTS),
      recentClient: lists.client.slice(0, MAX_SENT_EVENTS),
      log: { total: logErrorCount, inWindow: lists.log.length, recent: lists.log.slice(0, MAX_SENT_EVENTS) },
    },
    chart: chartHistory(fromMs ?? Math.min(startedAt.getTime(), now - HOUR_MS), toMs),
  }
}

/**
 * Forget the recorded error events, slow requests and logged errors, saved
 * ones included. The counts and charts are kept: they are traffic figures,
 * not the error log.
 */
export async function clearErrors(): Promise<void> {
  for (const s of SOURCES) s.ring.length = 0
  pendingEvents = []
  logErrorCount = 0
  errorsSince = new Date()
  if (started) await deleteEvents()
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
