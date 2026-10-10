// The collector driven directly with fake requests, so caps, slow requests and
// odd error shapes need no real traffic. Module state is this file's own.
import { describe, it, expect, vi, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import type { Request, Response } from "express"
import type { RowDataPacket } from "mysql2/promise"
import * as m from "../metrics.collector.js"
import { logger } from "../../../utils/logger.js"
import { pool } from "../../../config/database.js"

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await m.clearErrors()
})

interface Fake {
  status?: number
  url?: string
  routed?: boolean
  error?: unknown
  body?: unknown
  ms?: number
  aborted?: boolean
  req?: Record<string, unknown>
}

/** Runs one request through metricsMiddleware, taking `ms` by the clock. */
function hit({ status = 200, url = "/api/x", routed = true, error, body, ms = 1, aborted = false, req: extra }: Fake = {}) {
  let now = 1_000_000_000n
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now)
  const req = { path: url, method: "GET", originalUrl: url, route: routed ? {} : undefined, ip: "1.2.3.4", ...extra }
  const res = Object.assign(new EventEmitter(), {
    statusCode: status,
    locals: { error } as Record<string, unknown>,
    writableFinished: !aborted,
    json: () => res,
    getHeader: () => undefined,
  })
  m.metricsMiddleware(req as unknown as Request, res as unknown as Response, () => {})
  if (body !== undefined) (res as unknown as Response).json(body)
  now += BigInt(Math.round(ms * 1e6))
  res.emit(aborted ? "close" : "finish")
  vi.mocked(process.hrtime.bigint).mockRestore()
}

const snap = (window?: m.Window) => m.processSnapshot(window)

describe("metrics collector", () => {
  it("labels the root path", async () => {
    expect(m.routeLabel("GET", "/")).toBe("GET /")
  })

  it("describes every shape of error", async () => {
    hit({ status: 400, body: { code: "BAD_THING", error: "from the body", details: "plain text" } })
    hit({ status: 500, error: Object.assign(new Error(""), { errno: 1205, stack: undefined }) })
    hit({ status: 418, error: Object.assign(Object.create(null), { message: "bare" }) })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    hit({ status: 422, error: Object.assign(new Error("loop"), { details: circular }) })

    const s = await snap()
    const by = (status: number) => [...s.errors.recentClient, ...s.errors.recentServer].find((e) => e.status === status)
    expect(by(400)).toMatchObject({ code: "BAD_THING", message: "from the body", details: "plain text" })
    expect(by(418)).toMatchObject({ name: null, message: "bare", code: null })
    expect(by(422)).toMatchObject({ message: "loop", details: null })
    expect(by(500)).toMatchObject({ code: "ERRNO_1205", message: "(no message)", stack: null, ip: "1.2.3.4" })
  })

  it("keeps a request with no address", async () => {
    hit({ status: 404, req: { ip: undefined } })
    expect((await snap()).errors.recentClient[0]!.ip).toBeNull()
  })

  it("groups every kind of error, and caps routes per group, routes, and the lists sent", async () => {
    for (let i = 0; i < 301; i++) hit({ status: 400, error: new Error(`kind ${i}`) })
    expect((await snap()).errors.groups).toHaveLength(301)
    expect((await snap()).errors.recentClient).toHaveLength(200)

    await m.clearErrors()
    for (let i = 0; i < 11; i++) hit({ status: 409, url: `/api/r${i}`, error: new Error("same") })
    expect((await snap()).errors.groups[0]!.routes).toHaveLength(10)

    for (let i = 0; i < 210; i++) hit({ url: `/api/route${i}` })
    expect((await snap()).http.routes.some((r) => r.route === "(other)")).toBe(true)
  })

  it("counts errors in the window, and says where a full ring starts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    // Roll the earlier tests' traffic out of the window first.
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"))
    m.rollMinute()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    hit({ status: 400 })
    hit({ status: 400 })
    m.rollMinute()
    vi.setSystemTime(new Date("2026-01-01T00:20:00Z"))
    hit({ status: 400 })
    expect((await snap("15m")).errors.clientErrors).toBe(1)
    expect((await snap("15m")).errors.recentClient).toHaveLength(1)
    expect((await snap("1h")).errors.clientErrors).toBe(3)
    expect((await snap("1h")).errors.listsFrom).toBeNull()

    for (let i = 0; i < 2000; i++) hit({ status: 404 })
    expect((await snap("1h")).errors.listsFrom).toBe("2026-01-01T00:20:00.000Z")
    expect((await snap("1h")).errors.clientErrors).toBe(2003)
  })

  it("records slow requests with who made them, and counts aborted ones apart", async () => {
    hit({ ms: 1500, req: { reqId: "rq1", user: { username: "trainee" }, trainer: { username: "coach" } } })
    hit({ ms: 1500, req: { user: { username: "solo" } } })
    hit({ ms: 1500 })
    expect((await snap()).http.slowRequests.slice(0, 3).map((s) => s.user)).toEqual([null, "solo", "coach"])
    expect((await snap()).http.slowRequests[2]!.reqId).toBe("rq1")

    const before = (await snap()).http.aborted
    hit({ aborted: true })
    expect((await snap()).http.aborted).toBe(before + 1)
  })

  it("logs any kind of argument at error level", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const noStack = Object.assign(new Error("no stack"), { stack: undefined })
    logger.error("plain", noStack, { a: 1 }, 10n)
    expect((await snap()).errors.log.recent[0]!.message).toBe('plain no stack {"a":1} 10')
  })

  it("rolls empty and busy minutes, samples the event loop, and buckets long windows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"))
    // One clock minute per roll, as the real timer does.
    const roll = () => {
      vi.advanceTimersByTime(60_000)
      m.rollMinute()
    }
    roll()
    roll()
    expect((await snap()).chart.points.at(-1)).toMatchObject({ requests: 0, avgMs: null, p95Ms: null, eventLoopP99Ms: null })

    // The same clock reading twice: no time passed, so no CPU figure.
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(5n)
    roll()
    roll()
    expect((await snap()).chart.points.at(-1)!.cpuPercent).toBe(0)
    vi.restoreAllMocks()

    await Promise.all([m.startMetricsCollector(), m.startMetricsCollector()])
    await new Promise((r) => setTimeout(r, 150))
    expect((await snap()).process.eventLoopDelayMs).toMatchObject({ p99: expect.any(Number) })
    hit()
    roll()
    expect((await snap()).chart.points.at(-1)!.eventLoopP99Ms).toEqual(expect.any(Number))
    await m.stopMetricsCollector()
    await m.stopMetricsCollector()

    // 30 days and a minute: past a day, minutes are rolled up into hours.
    for (let i = 0; i < 30 * 1440 + 1; i++) roll()
    expect((await snap("1h")).chart).toMatchObject({ bucketMinutes: 1, slots: 60 })
    expect((await snap("1h")).chart.points).toHaveLength(60)
    expect((await snap("24h")).chart).toMatchObject({ bucketMinutes: 12, slots: 120 })
    expect((await snap("24h")).chart.points).toHaveLength(120)
    expect((await snap("7d")).chart).toMatchObject({ bucketMinutes: 120, slots: 84 })
    expect((await snap("7d")).chart.points.length).toBeGreaterThanOrEqual(83)
    expect((await snap("30d")).chart).toMatchObject({ bucketMinutes: 360, slots: 120 })
    expect((await snap("30d")).chart.points.length).toBeGreaterThanOrEqual(119)
    // Hours keep their requests: the first hour of rolls, with the requests
    // made above, still ends inside the 30 days.
    expect((await snap("30d")).http.totalRequests).toBeGreaterThanOrEqual(1)
    const to = Date.now() - 10 * 86_400_000
    const range = await snap({ fromMs: to - 86_400_000, toMs: to })
    expect(range.window).toMatchObject({ key: "custom", minutes: 1440 })
    expect(range.chart.bucketMinutes).toBe(60)
    expect(range.http.totalRequests).toBe(0)
  })

  it("saves history and events, and reads a window older than memory from the database", async () => {
    await pool.query("DELETE FROM metrics_history")
    await pool.query("DELETE FROM metrics_events")
    const old = Date.now() - 3 * 86_400_000
    await pool.query("INSERT INTO metrics_events (kind, at_ms, data) VALUES (1, ?, ?)", [
      old,
      JSON.stringify({ at: new Date(old).toISOString(), status: 404, code: null, name: null, message: "from before", route: "r" }),
    ])
    await m.startMetricsCollector()
    hit({ status: 503, error: new Error("saved one") })
    const week = await snap("7d")
    expect(week.errors.recentClient.some((e) => e.message === "from before")).toBe(true)
    expect(week.errors.recentServer.some((e) => e.message === "saved one")).toBe(true)
    await m.stopMetricsCollector()
    const [h] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM metrics_history WHERE span_min = 1")
    expect(h[0].n).toBeGreaterThanOrEqual(1)
    const [e] = await pool.query<RowDataPacket[]>("SELECT data FROM metrics_events WHERE kind = 0")
    expect(e.some((r) => String(r.data).includes("saved one"))).toBe(true)
    // The IP is shown live but never saved.
    expect(e.some((r) => String(r.data).includes("1.2.3.4"))).toBe(false)
    await pool.query("DELETE FROM metrics_history")
    await pool.query("DELETE FROM metrics_events")
  })
})

describe("metricsBanner when switched off", () => {
  it.each([
    [{ METRICS_ENABLED: "false" }, "Admin metrics are off"],
    [{ METRICS_PAGE_ENABLED: "false" }, "page off: METRICS_PAGE_ENABLED=false"],
  ])("%o", async (env, text) => {
    vi.resetModules()
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      const fresh = await import("../metrics.collector.js")
      expect(fresh.metricsBanner({ port: 1 })).toContain(text)
    } finally {
      process.env = saved
    }
  })
})
