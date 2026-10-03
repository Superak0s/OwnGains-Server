import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import express from "express"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import { errorHandler, AppError } from "../../../middleware/errorHandler.js"
import { logger } from "../../../utils/logger.js"
import {
  metricsMiddleware,
  percentileOf,
  processSnapshot,
  rollMinuteForTest,
  routeLabel,
} from "../metrics.collector.js"

describe("admin metrics", () => {
  let admin: Awaited<ReturnType<typeof signup>>
  let plain: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    admin = await signup("madm")
    plain = await signup("mplain")
    await pool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [await internalId(admin.user.id)])
  })

  // __tests__/owngains.test.ts briefly demotes every other admin to test the
  // CLI's last-admin guard. Re-assert before each test so that window can't
  // turn into a stray 403 here.
  beforeEach(async () => {
    await pool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [await internalId(admin.user.id)])
  })

  it("refuses anonymous callers and non-admins", async () => {
    expect((await request(app).get("/api/admin/metrics")).status).toBe(401)
    expect((await request(app).get("/api/admin/metrics").set(auth(plain.token))).status).toBe(403)
  })

  it("reports process, HTTP, websocket and database figures to an admin", async () => {
    // Something for the route table to have counted.
    await request(app).get("/api/auth/me").set(auth(plain.token))

    const res = await request(app).get("/api/admin/metrics").set(auth(admin.token))
    expect(res.status).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-store")
    const m = res.body
    expect(m.success).toBe(true)
    expect(m.process.memory.rssMb).toBeGreaterThan(0)
    expect(m.http.totalRequests).toBeGreaterThan(0)
    expect(m.http.routes.some((r: { route: string }) => r.route === "GET /api/auth/me")).toBe(true)
    expect(m.websocket).toMatchObject({ connectedUsers: expect.any(Number) })
    expect(m.database.errors).toEqual([])
    expect(m.database.app.users.total).toBeGreaterThanOrEqual(2)
    expect(m.database.app.users.admins).toBeGreaterThanOrEqual(1)
    expect(m.database.size.tables.some((t: { name: string }) => t.name === "users")).toBe(true)
    expect(m.database.pool.limit).toBeGreaterThan(0)
    // Nothing secret leaks through the config summary.
    expect(JSON.stringify(m)).not.toContain(process.env.JWT_SECRET!)
    expect(JSON.stringify(m)).not.toContain(process.env.DB_PASSWORD || "\u0000")
  })

  it("serves the dashboard page with a nonce CSP and no data in it", async () => {
    const res = await request(app).get("/admin/metrics")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    const csp = res.headers["content-security-policy"]
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.text).toContain(`<script nonce="${nonce}">`)
    expect(res.text).not.toContain("__NONCE__")
    expect(res.headers["cache-control"]).toBe("no-store")
  })
})

describe("routeLabel", () => {
  it("collapses ids, uuids and dates and drops the query string", () => {
    expect(routeLabel("POST", "/api/sessions/42/set?x=1")).toBe("POST /api/sessions/:id/set")
    expect(routeLabel("GET", "/api/friends/0b8e6c2a-3c1f-4d5e-9a7b-1c2d3e4f5a6b/")).toBe(
      "GET /api/friends/:id",
    )
    expect(routeLabel("GET", "/api/tracking/hydration/2026-09-27")).toBe(
      "GET /api/tracking/hydration/:date",
    )
  })
})

describe("error capture", () => {
  // A throwaway app with the real middleware and error handler, so a 500 can
  // be produced on demand without a broken route in the real one.
  const mini = express()
  mini.use(metricsMiddleware)
  mini.get("/boom/:id", () => {
    throw new Error("kaboom: disk on fire")
  })
  mini.get("/teapot", () => {
    throw new AppError("short and stout", 418, null, "TEAPOT")
  })
  mini.use((_req, res) => void res.status(404).json({ success: false, error: "Route not found" }))
  mini.use(errorHandler)

  it("records the real 5xx message, type and stack even when the response masks it", async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const res = await request(mini).get("/boom/42")
      expect(res.status).toBe(500)
      expect(res.body.error).toBe("Internal server error")
    } finally {
      process.env.NODE_ENV = prev
      vi.restoreAllMocks()
    }
    const { errors } = processSnapshot()
    const ev = errors.recentServer.find((e) => e.message === "kaboom: disk on fire")
    expect(ev).toMatchObject({ status: 500, route: "GET /boom/:id", name: "Error", path: "/boom/42" })
    expect(ev!.stack).toContain("kaboom")
    const group = errors.groups.find((g) => g.message === "kaboom: disk on fire")
    expect(group!.routes).toEqual([{ route: "GET /boom/:id", count: 1 }])
    // errorHandler's logger.error is recorded in the error log too.
    expect(errors.log.recent.some((l) => l.message.includes("kaboom"))).toBe(true)
  })

  it("groups 4xx by status, code and message, and keeps unrouted 404s in one label", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    await request(mini).get("/teapot")
    await request(mini).get("/teapot")
    await request(mini).get("/nope/a")
    await request(mini).get("/nope/b")
    vi.restoreAllMocks()
    const { errors, http } = processSnapshot()
    const tea = errors.groups.find((g) => g.code === "TEAPOT")
    expect(tea).toMatchObject({ status: 418, message: "short and stout", name: "AppError" })
    expect(tea!.count).toBeGreaterThanOrEqual(2)
    const notFound = errors.groups.find((g) => g.status === 404 && g.message === "Route not found")
    expect(notFound!.routes.find((r) => r.route === "(unrouted)")!.count).toBeGreaterThanOrEqual(2)
    expect(http.byStatus["418"]).toBeGreaterThanOrEqual(2)
    // No stack kept for a client error.
    expect(errors.recentClient.find((e) => e.code === "TEAPOT")!.stack).toBeNull()
    expect(errors.recentClient.find((e) => e.code === "TEAPOT")!.details).toBeNull()
  })

  it("logs a 4xx as one info line and a 5xx with its stack", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      await request(mini).get("/teapot")
      await request(mini).get("/boom/7")
    } finally {
      process.env.NODE_ENV = prev
    }
    const line = info.mock.calls.find((c) => String(c[1]).startsWith("418"))
    expect(line![1]).toMatch(/^418 GET \/teapot: short and stout \[TEAPOT\] \(reqId /)
    expect(warn).not.toHaveBeenCalled()
    const logged = error.mock.calls.find((c) => c[1] === "Server error:")![2] as { stack?: string }
    expect(logged.stack).toContain("kaboom")
    vi.restoreAllMocks()
  })

  it("keeps anything logged at error level outside a request", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    logger.error("[SESSION_CLEANUP] Cleanup run failed:", "lock wait timeout")
    vi.restoreAllMocks()
    const { errors } = processSnapshot()
    expect(errors.log.recent[0].message).toBe("[SESSION_CLEANUP] Cleanup run failed: lock wait timeout")
  })

  it("adds a per-minute point with p95/p99", async () => {
    await request(mini).get("/teapot")
    rollMinuteForTest()
    const { history } = processSnapshot()
    const last = history[history.length - 1]
    expect(last.requests).toBeGreaterThanOrEqual(1)
    expect(last.p99Ms).not.toBeNull()
    expect(last.clientErrors).toBeGreaterThanOrEqual(1)
  })
})

describe("admin error log over HTTP", () => {
  it("reports per-route percentiles and clears the error log on DELETE", async () => {
    const admin = await signup("mclr")
    await pool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [await internalId(admin.user.id)])
    await request(app).get("/api/auth/me") // a 401 to record

    const before = await request(app).get("/api/admin/metrics").set(auth(admin.token))
    const me = before.body.http.routes.find((r: { route: string }) => r.route === "GET /api/auth/me")
    expect(me.p99Ms).toEqual(expect.any(Number))
    expect(me.byStatus).toBeTypeOf("object")
    expect(before.body.errors.groups.some((g: { status: number }) => g.status === 401)).toBe(true)

    const plain = await signup("mclr2")
    expect((await request(app).delete("/api/admin/metrics/errors").set(auth(plain.token))).status).toBe(403)
    expect((await request(app).delete("/api/admin/metrics/errors").set(auth(admin.token))).status).toBe(200)
    const after = await request(app).get("/api/admin/metrics").set(auth(admin.token))
    // The 403 above and anything else before the clear are gone.
    expect(after.body.errors.groups.some((g: { status: number }) => g.status === 401)).toBe(false)
  })
})

describe("percentileOf", () => {
  it("interpolates inside a bucket and never exceeds the max seen", () => {
    const b = new Array(28).fill(0)
    b[11] = 100 // (75, 100] ms
    expect(percentileOf(b, 0.5, 100)).toBe(87.5)
    expect(percentileOf(b, 0.99, 90)).toBe(90)
    expect(percentileOf(new Array(28).fill(0), 0.5, 0)).toBeNull()
  })
})

describe("metricsBanner", () => {
  it("lists every address the dashboard is reachable on, in an aligned box", async () => {
    const { metricsBanner } = await import("../metrics.collector.js")
    const banner = metricsBanner({ port: 5000, lanIp: "192.168.1.20", fqdn: "lift.example.com" })
    expect(banner).toContain("http://localhost:5000/admin/metrics")
    expect(banner).toContain("http://192.168.1.20:5000/admin/metrics")
    expect(banner).toContain("https://lift.example.com/admin/metrics")
    const lengths = new Set(banner.split("\n").map((l) => l.length))
    expect(lengths.size).toBe(1)
  })
})
