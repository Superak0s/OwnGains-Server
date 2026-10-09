// The collector driven directly with fake requests, so caps, slow requests and
// odd error shapes need no real traffic. Module state is this file's own.
import { describe, it, expect, vi, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import type { Request, Response } from "express"
import * as m from "../metrics.collector.js"
import { logger } from "../../../utils/logger.js"

afterEach(() => {
  vi.restoreAllMocks()
  m.clearErrors()
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

const snap = () => m.processSnapshot()

describe("metrics collector", () => {
  it("labels the root path", () => {
    expect(m.routeLabel("GET", "/")).toBe("GET /")
  })

  it("describes every shape of error", () => {
    hit({ status: 400, body: { code: "BAD_THING", error: "from the body", details: "plain text" } })
    hit({ status: 500, error: Object.assign(new Error(""), { errno: 1205, stack: undefined }) })
    hit({ status: 418, error: Object.assign(Object.create(null), { message: "bare" }) })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    hit({ status: 422, error: Object.assign(new Error("loop"), { details: circular }) })

    const by = (status: number) => [...snap().errors.recentClient, ...snap().errors.recentServer].find((e) => e.status === status)
    expect(by(400)).toMatchObject({ code: "BAD_THING", message: "from the body", details: "plain text" })
    expect(by(418)).toMatchObject({ name: null, message: "bare", code: null })
    expect(by(422)).toMatchObject({ message: "loop", details: null })
    expect(by(500)).toMatchObject({ code: "ERRNO_1205", message: "(no message)", stack: null, ip: "1.2.3.4" })
  })

  it("keeps a request with no address", () => {
    hit({ status: 404, req: { ip: undefined } })
    expect(snap().errors.recentClient[0]!.ip).toBeNull()
  })

  it("caps error groups, routes per group, routes, and the recent lists", () => {
    for (let i = 0; i < 301; i++) hit({ status: 400, error: new Error(`kind ${i}`) })
    const groups = snap().errors.groups
    expect(groups).toHaveLength(301)
    expect(groups.find((g) => g.status === 0)).toMatchObject({ message: "(other errors: too many distinct kinds)", count: 1 })
    expect(snap().errors.recentClient).toHaveLength(200)

    m.clearErrors()
    for (let i = 0; i < 11; i++) hit({ status: 409, url: `/api/r${i}`, error: new Error("same") })
    expect(snap().errors.groups[0]!.routes).toHaveLength(10)

    for (let i = 0; i < 210; i++) hit({ url: `/api/route${i}` })
    expect(snap().http.routes.some((r) => r.route === "(other)")).toBe(true)
  })

  it("records slow requests with who made them, and counts aborted ones apart", () => {
    hit({ ms: 1500, req: { reqId: "rq1", user: { username: "trainee" }, trainer: { username: "coach" } } })
    hit({ ms: 1500, req: { user: { username: "solo" } } })
    hit({ ms: 1500 })
    expect(snap().http.slowRequests.slice(0, 3).map((s) => s.user)).toEqual([null, "solo", "coach"])
    expect(snap().http.slowRequests[2]!.reqId).toBe("rq1")

    const before = snap().http.aborted
    hit({ aborted: true })
    expect(snap().http.aborted).toBe(before + 1)
  })

  it("logs any kind of argument at error level", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const noStack = Object.assign(new Error("no stack"), { stack: undefined })
    logger.error("plain", noStack, { a: 1 }, 10n)
    expect(snap().errors.log.recent[0]!.message).toBe('plain no stack {"a":1} 10')
  })

  it("rolls empty and busy minutes, samples the event loop, and keeps 60 points", async () => {
    m.rollMinute()
    m.rollMinute()
    expect(snap().history.at(-1)).toMatchObject({ requests: 0, avgMs: null, p95Ms: null, eventLoopP99Ms: null })

    // The same clock reading twice: no time passed, so no CPU figure.
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(5n)
    m.rollMinute()
    m.rollMinute()
    expect(snap().history.at(-1)!.cpuPercent).toBe(0)
    vi.restoreAllMocks()

    m.startMetricsCollector()
    m.startMetricsCollector()
    await new Promise((r) => setTimeout(r, 150))
    expect(snap().process.eventLoopDelayMs).toMatchObject({ p99: expect.any(Number) })
    hit()
    m.rollMinute()
    expect(snap().history.at(-1)!.eventLoopP99Ms).toEqual(expect.any(Number))
    m.stopMetricsCollector()
    m.stopMetricsCollector()

    for (let i = 0; i < 61; i++) m.rollMinute()
    expect(snap().history).toHaveLength(60)
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
