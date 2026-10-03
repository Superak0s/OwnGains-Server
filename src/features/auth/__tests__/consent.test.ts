// GDPR consent records (Art. 7(1), Art. 9), the health-consent guard on
// tracking writes, the local-only profile gate and report retention.

import { describe, it, expect, afterEach } from "vitest"
import request from "supertest"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { app, signup, auth, uniqueName, internalId } from "../../../tests/helpers.js"
import { pool } from "@/config/database.js"
import { purgeOldReports } from "@/features/social/friends/friends.model.js"

afterEach(() => {
  delete process.env.REQUIRE_HEALTH_CONSENT
  delete process.env.LOCAL_ONLY_FEATURES
})

describe("consent", () => {
  it("records consent given at signup", async () => {
    const username = uniqueName("cons")
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ username, email: `${username}@test.local`, password: "Passw0rd-123", termsVersion: "September 2026", healthConsent: true })
    expect(res.status).toBe(201)
    expect(res.body.user.termsVersion).toBe("September 2026")
    expect(res.body.user.termsAcceptedAt).toBeTruthy()
    expect(res.body.user.healthConsentAt).toBeTruthy()
  })

  it("rejects malformed consent fields", async () => {
    const u = await signup("cons")
    const res = await request(app).put("/api/auth/consent").set(auth(u.token)).send({ healthConsent: "yes" })
    expect(res.status).toBe(400)
    const empty = await request(app).put("/api/auth/consent").set(auth(u.token)).send({})
    expect(empty.status).toBe(400)
  })

  it("grants and withdraws health consent, gating tracking writes but not reads", async () => {
    const username = uniqueName("cons")
    const su = await request(app)
      .post("/api/auth/signup")
      .send({ username, email: `${username}@test.local`, password: "Passw0rd-123", termsVersion: "September 2026" })
    const token = su.body.token
    expect(su.body.user.healthConsentAt).toBeNull()

    const blocked = await request(app).post("/api/tracking/hydration").set(auth(token)).send({ amountMl: 100 })
    expect(blocked.status).toBe(403)
    expect(blocked.body.code).toBe("HEALTH_CONSENT_REQUIRED")
    const read = await request(app).get("/api/tracking/hydration").set(auth(token))
    expect(read.status).not.toBe(403)

    const grant = await request(app).put("/api/auth/consent").set(auth(token)).send({ healthConsent: true })
    expect(grant.status).toBe(200)
    expect(grant.body.user.healthConsentAt).toBeTruthy()
    const ok = await request(app).post("/api/tracking/hydration").set(auth(token)).send({ amountMl: 100 })
    expect(ok.status).toBe(201)

    const withdraw = await request(app).put("/api/auth/consent").set(auth(token)).send({ healthConsent: false })
    expect(withdraw.body.user.healthConsentAt).toBeNull()
    const again = await request(app).post("/api/tracking/hydration").set(auth(token)).send({ amountMl: 100 })
    expect(again.status).toBe(403)
  })

  it("lets an operator turn the health consent gate off", async () => {
    process.env.REQUIRE_HEALTH_CONSENT = "false"
    const u = await signup("cons")
    await request(app).put("/api/auth/consent").set(auth(u.token)).send({ healthConsent: false })
    const res = await request(app).post("/api/tracking/hydration").set(auth(u.token)).send({ amountMl: 100 })
    expect(res.status).toBe(201)
  })

  it("erases stored health data when consent is withdrawn", async () => {
    const u = await signup("cons")
    const id = await internalId(u.user.id)
    expect((await request(app).post("/api/tracking/hydration").set(auth(u.token)).send({ amountMl: 100 })).status).toBe(201)
    await pool.execute("UPDATE users SET height_cm = 180 WHERE id = ?", [id])
    await request(app).put("/api/auth/consent").set(auth(u.token)).send({ healthConsent: false })
    const [m] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM measurements WHERE user_id = ?", [id])
    expect(Number(m[0].n)).toBe(0)
    const [p] = await pool.execute<RowDataPacket[]>("SELECT height_cm FROM users WHERE id = ?", [id])
    expect(p[0].height_cm).toBeNull()
  })

  it("keeps a consent history and erases settings on withdrawal", async () => {
    const u = await signup("cons")
    const id = await internalId(u.user.id)
    await request(app).patch("/api/settings").set(auth(u.token)).send({ cycleLengthDays: 30 }).expect(200)
    await request(app).put("/api/auth/consent").set(auth(u.token)).send({ healthConsent: false })
    await request(app).put("/api/auth/consent").set(auth(u.token)).send({ healthConsent: false })
    await request(app).put("/api/auth/consent").set(auth(u.token)).send({ healthConsent: true, termsVersion: "October 2026" })
    const [s] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?", [id])
    expect(Number(s[0].n)).toBe(0)
    const [events] = await pool.execute<RowDataPacket[]>(
      "SELECT kind, version, granted FROM consent_events WHERE user_id = ? ORDER BY id",
      [id],
    )
    expect(events.map((e) => [e.kind, e.version, e.granted])).toEqual([
      ["terms", "test", 1],
      ["health", null, 1],
      ["health", null, 0],
      ["terms", "October 2026", 1],
      ["health", null, 1],
    ])
  })

  it("keeps pre-consent data when a user who never consented sends false", async () => {
    const u = await signup("cons")
    const id = await internalId(u.user.id)
    await request(app).post("/api/tracking/hydration").set(auth(u.token)).send({ amountMl: 100 })
    await pool.execute("UPDATE users SET health_consent_at = NULL WHERE id = ?", [id])
    await request(app).put("/api/auth/consent").set(auth(u.token)).send({ healthConsent: false })
    const [m] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM measurements WHERE user_id = ?", [id])
    expect(Number(m[0].n)).toBe(1)
  })

  it("gates workout writes on health consent and erases workouts on withdrawal", async () => {
    const username = uniqueName("cons")
    const su = await request(app)
      .post("/api/auth/signup")
      .send({ username, email: `${username}@test.local`, password: "Passw0rd-123", termsVersion: "September 2026" })
    const token = su.body.token
    const blocked = await request(app).post("/api/sessions/start").set(auth(token)).send({ dayNumber: 1, dayTitle: "Push" })
    expect(blocked.status).toBe(403)
    expect(blocked.body.code).toBe("HEALTH_CONSENT_REQUIRED")

    await request(app).put("/api/auth/consent").set(auth(token)).send({ healthConsent: true })
    const started = await request(app).post("/api/sessions/start").set(auth(token)).send({ dayNumber: 1, dayTitle: "Push" })
    expect(started.status).toBe(200)

    await request(app).put("/api/auth/consent").set(auth(token)).send({ healthConsent: false })
    const id = await internalId(su.body.user.id)
    const [w] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM workouts WHERE user_id = ?", [id])
    expect(Number(w[0].n)).toBe(0)
  })

  it("refuses writes until the Terms are accepted, leaving /api/auth and reads open", async () => {
    const username = uniqueName("cons")
    const su = await request(app)
      .post("/api/auth/signup")
      .send({ username, email: `${username}@test.local`, password: "Passw0rd-123" })
    const token = su.body.token
    const write = await request(app).post("/api/sessions/start").set(auth(token)).send({ dayNumber: 1, dayTitle: "Push" })
    expect(write.status).toBe(403)
    expect(write.body.code).toBe("TERMS_NOT_ACCEPTED")
    expect((await request(app).get("/api/sessions").set(auth(token))).status).not.toBe(403)
    const accept = await request(app).put("/api/auth/consent").set(auth(token)).send({ termsVersion: "September 2026", healthConsent: true })
    expect(accept.status).toBe(200)
    const after = await request(app).post("/api/sessions/start").set(auth(token)).send({ dayNumber: 1, dayTitle: "Push" })
    expect(after.status).not.toBe(403)
  })

  it("ignores body fields on PUT /profile while tracking is local-only", async () => {
    const u = await signup("cons")
    process.env.LOCAL_ONLY_FEATURES = "tracking"
    const res = await request(app).put("/api/auth/profile").set(auth(u.token)).send({ heightCm: 182, name: "Kept" })
    expect(res.status).toBe(200)
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT name, height_cm FROM users WHERE uuid = ?", [u.user.id])
    expect(rows[0].name).toBe("Kept")
    expect(rows[0].height_cm).toBeNull()
  })

  it("purges reports past the retention window", async () => {
    const a = await signup("cons")
    const reporter = await internalId(a.user.id)
    const insert = (age: string) =>
      pool.execute<ResultSetHeader>(
        `INSERT INTO user_reports (reporter_id, reason, created_at) VALUES (?, 'spam', NOW() - INTERVAL ${age})`,
        [reporter],
      )
    const [old] = await insert("400 DAY")
    const [recent] = await insert("10 DAY")
    await purgeOldReports(365)
    const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM user_reports WHERE id IN (?)", [[old.insertId, recent.insertId]])
    expect(rows.map((r) => r.id)).toEqual([recent.insertId])
  })
})
