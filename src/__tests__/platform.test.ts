import { describe, it, expect, beforeEach, afterEach } from "vitest"
import express from "express"
import request from "supertest"
import { app, beginDrain } from "../server.js"
import { errorHandler, ValidationError, isDbUnavailableError } from "../middleware/errorHandler.js"
import { signup, auth } from "../tests/helpers.js"
import { pool, queryTimeoutMs, testDatabaseConnection } from "../config/database.js"
import type { RowDataPacket } from "mysql2/promise"

// Platform hardening: overload → 503 mapping (H9), the split auth limiters
// (H2), the per-user 2mb-parser limiter (M20) and /healthz draining (L6).

describe("errorHandler: database overload is a retryable 503 (H9)", () => {
  const cases: [string, () => Error][] = [
    ["pool queue full", () => new Error("Queue limit reached.")],
    ["MySQL statement timeout", () => Object.assign(new Error("timeout"), { errno: 3024 })],
    ["MariaDB statement timeout", () => Object.assign(new Error("timeout"), { errno: 1969 })],
    ["connect timeout", () => Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
    ["lock wait timeout", () => Object.assign(new Error("lock"), { errno: 1205 })],
  ]

  const mini = (make: () => Error) => {
    const a = express()
    a.get("/x", () => {
      throw make()
    })
    a.use(errorHandler)
    return a
  }

  it.each(cases)("%s", async (_name, make) => {
    const res = await request(mini(make)).get("/x")
    expect(res.status).toBe(503)
    expect(res.headers["retry-after"]).toBe("5")
    expect(res.body).toMatchObject({ success: false, code: "SERVICE_UNAVAILABLE" })
    // The driver's text never reaches the client.
    expect(JSON.stringify(res.body)).not.toMatch(/Queue limit|ETIMEDOUT/)
  })

  it("leaves ordinary errors alone", async () => {
    expect(isDbUnavailableError(new ValidationError("bad"))).toBe(false)
    expect(isDbUnavailableError(Object.assign(new Error("dup"), { errno: 1062 }))).toBe(false)
    const res = await request(mini(() => new ValidationError("bad"))).get("/x")
    expect(res.status).toBe(400)
    expect(res.headers["retry-after"]).toBeUndefined()
  })
})

// The limiters skip themselves under VITEST. These tests switch that off for
// their own duration only.
describe("rate limiters", () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.VITEST
    delete process.env.VITEST
  })
  afterEach(() => {
    process.env.VITEST = saved
  })

  it("H2: failed signins hit the strict limiter; /refresh and /me stay on the general one", async () => {
    // An empty body fails validation (400) without paying for bcrypt, and a
    // 400 counts as a failure just like a wrong password.
    for (let i = 0; i < 20; i++)
      expect((await request(app).post("/api/auth/signin").send({})).status).toBe(400)
    expect((await request(app).post("/api/auth/signin").send({})).status).toBe(429)
    // Same bucket for the other password-checking routes.
    expect((await request(app).put("/api/auth/password").send({})).status).toBe(429)

    // Token refresh from the same IP is unaffected. This is what used to log
    // out every device behind one NAT.
    const refresh = await request(app).post("/api/auth/refresh").send({})
    expect(refresh.status).not.toBe(429)
    const me = await request(app).get("/api/auth/me")
    expect(me.status).toBe(401)
  })

  it("M20: the 2mb parser paths are limited per user, only for large bodies", async () => {
    process.env.VITEST = saved // signup itself must not be limited here
    const u = await signup("plat")
    delete process.env.VITEST

    // Small bodies and GETs don't count.
    for (let i = 0; i < 25; i++) {
      const res = await request(app).get("/api/sharing/permissions/granted").set(auth(u.token))
      expect(res.status).not.toBe(429)
    }

    const big = JSON.stringify({ program: { pad: "x".repeat(60 * 1024) } })
    const post = () =>
      request(app)
        .post("/api/program/upload")
        .set(auth(u.token))
        .set("Content-Type", "application/json")
        .send(big)
    for (let i = 0; i < 20; i++) expect((await post()).status).not.toBe(429)
    expect((await post()).status).toBe(429)

    // Another user has their own budget.
    process.env.VITEST = saved
    const other = await signup("plat")
    delete process.env.VITEST
    const res = await request(app)
      .post("/api/program/upload")
      .set(auth(other.token))
      .set("Content-Type", "application/json")
      .send(big)
    expect(res.status).not.toBe(429)
  })
})

describe("database boot and pool (H9, M17)", () => {
  it("serialises concurrent provisioning under the migration lock", async () => {
    // Both must complete (testDatabaseConnection exits the process on failure).
    await Promise.all([testDatabaseConnection(), testDatabaseConnection()])
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT name, COUNT(*) AS n FROM _migrations GROUP BY name HAVING n > 1",
    )
    expect(rows).toEqual([])
  })

  it("gives pooled connections a server-side statement timeout", async () => {
    const [[row]] = await pool.query<RowDataPacket[]>(
      "SELECT VERSION() AS v, @@SESSION.max_statement_time AS mariadb",
    ).catch(() =>
      pool.query<RowDataPacket[]>("SELECT VERSION() AS v, @@SESSION.max_execution_time AS mysql"),
    )
    if (/mariadb/i.test(String(row!.v))) expect(Number(row!.mariadb)).toBe(queryTimeoutMs / 1000)
    else expect(Number(row!.mysql)).toBe(queryTimeoutMs)
  })
})

// Last: draining is one-way for the life of this worker's app.
describe("/healthz while draining (L6)", () => {
  it("answers 503 once shutdown has begun", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200)
    beginDrain()
    const res = await request(app).get("/healthz")
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: "DRAINING" })
  })
})
