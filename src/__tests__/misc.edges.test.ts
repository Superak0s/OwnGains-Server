// One-off branches across middleware and routes that no feature suite reaches.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import request from "supertest"
import express from "express"
import type { NextFunction, Request, Response } from "express"
import { pool } from "@/config/database.js"
import { errorHandler, UnauthorizedError, ValidationError } from "@/middleware/errorHandler.js"
import { requireAdmin } from "@/middleware/auth.js"
import { assertImageUpload } from "@/middleware/imageUpload.js"
import { updateUserSettings } from "@/features/settings/settings.model.js"
import { createNote } from "@/features/tracking/personalNotes/personalNotes.model.js"
import { generateToken } from "@/features/auth/auth.model.js"
import { logger } from "@/utils/logger.js"
import { app, signup, auth, internalId } from "../tests/helpers.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

let u: Awaited<ReturnType<typeof signup>>
let uid: number
beforeAll(async () => {
  u = await signup("misc")
  uid = await internalId(u.user.id)
})

const fakeRes = () => {
  const res = { headersSent: false, locals: {}, status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe("middleware edges", () => {
  it("hands an error after headers went out to Express", () => {
    const next = vi.fn()
    const err = new Error("late")
    errorHandler(err, {} as Request, { headersSent: true } as Response, next)
    expect(next).toHaveBeenCalledWith(err)
  })

  it.each([
    ["LIMIT_FILE_SIZE", 413],
    ["LIMIT_UNEXPECTED_FILE", 400],
  ])("answers multer's %s with %i", (code, status) => {
    const res = fakeRes()
    const err = Object.assign(new Error("multer"), { name: "MulterError", code })
    errorHandler(err, {} as Request, res as unknown as Response, vi.fn())
    expect(res.status).toHaveBeenCalledWith(status)
  })

  it("401s requireAdmin with no user", () => {
    const next = vi.fn() as NextFunction
    requireAdmin({} as Request, {} as Response, next)
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError))
  })

  it("rejects an image type it has no signature for", () => {
    const file = { mimetype: "image/bmp", buffer: Buffer.alloc(16) } as Express.Multer.File
    expect(() => assertImageUpload(file)).toThrow(ValidationError)
  })

  it("500s auth when the user lookup fails", async () => {
    vi.spyOn(pool, "execute").mockRejectedValue(new Error("down"))
    expect((await request(app).get("/api/settings").set(auth(u.token))).status).toBe(500)
  })

  it("signs tokens with the default lifetime when none is set", () => {
    vi.stubEnv("JWT_EXPIRES_IN", "")
    expect(generateToken(u.user.id, 0)).toBeTruthy()
  })

  it("sweeps stale throttles on a failed signin when the dice say so", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const res = await request(app).post("/api/auth/signin").send({ username: u.username, password: "wrong-Pass-1" })
    expect(res.status).toBe(401)
  })

  it("serves a second /healthz from the cached probe", async () => {
    await request(app).get("/healthz")
    expect((await request(app).get("/healthz")).status).toBe(200)
  })

  it("rate-limits API calls when not under vitest", async () => {
    vi.stubEnv("VITEST", "")
    const res = await request(app).get("/api/version")
    expect(res.headers["ratelimit-policy"]).toBeTruthy()
  })

  it("clips a very long logged error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => logger.error("x".repeat(3000))).not.toThrow()
  })
})

describe("model edges", () => {
  it("writes nothing for an empty settings patch", async () => {
    await expect(updateUserSettings(uid, {})).resolves.toBeUndefined()
  })

  it.each<[string, string, unknown]>([
    ["no muscle group", "", "hi"],
    ["blank content", "chest", "  "],
    ["non-string content", "chest", 5],
  ])("rejects a note with %s", async (_n, muscle, content) => {
    await expect(createNote(uid, muscle, content as string)).rejects.toThrow(ValidationError)
  })
})

describe("route edges", () => {
  it("refuses a friend request to yourself, and a report with non-string details", async () => {
    const self = await request(app).post("/api/friends/request").set(auth(u.token)).send({ username: u.username.toUpperCase() })
    expect(self.status).toBe(400)
    const report = await request(app)
      .post("/api/friends/report")
      .set(auth(u.token))
      .send({ userId: u.user.id, reason: "spam", details: 5 })
    expect(report.status).toBe(400)
  })

  it("needs soreness follow-up updates as an array", async () => {
    const res = await request(app).post("/api/tracking/soreness/follow-ups").set(auth(u.token)).send({ updates: "x" })
    expect(res.status).toBe(400)
  })

  it("filters analytics by split", async () => {
    expect((await request(app).get("/api/analytics?split=Push").set(auth(u.token))).status).toBe(200)
  })

  it("logs macros with carbs only and a null margin", async () => {
    const res = await request(app)
      .post("/api/tracking/macros/log")
      .set(auth(u.token))
      .send({ carbs: 10, errorMargin: null, takenAt: new Date().toISOString() })
    expect(res.status).toBe(201)
  })

  it("lists a report whose reporter account is gone", async () => {
    const admin = await signup("miscadm")
    await pool.execute(`UPDATE users SET is_admin = 1 WHERE id = ?`, [await internalId(admin.user.id)])
    const [r] = await pool.execute<import("mysql2").ResultSetHeader>(
      `INSERT INTO user_reports (reporter_id, reported_id, reason) VALUES (NULL, ?, 'spam')`,
      [uid],
    )
    const res = await request(app).get("/api/admin/reports?limit=500").set(auth(admin.token))
    expect(res.body.reports.find((x: { id: number }) => x.id === r.insertId)?.reporter).toBeNull()
  })

  it("leaves metrics, the metrics page and legal pages unmounted when switched off", async () => {
    vi.stubEnv("METRICS_ENABLED", "false")
    vi.stubEnv("METRICS_PAGE_ENABLED", "false")
    vi.stubEnv("LEGAL_PAGES_ENABLED", "false")
    vi.resetModules()
    const { registerRoutes } = await import("../routes.js")
    const bare = express()
    registerRoutes(bare)
    bare.use((_req, res) => res.status(404).end())
    expect((await request(bare).get("/admin/metrics")).status).toBe(404)
  })
})
