import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"
import { pool } from "@/config/database.js"
import { purgeDeletedAccounts } from "../auth.model.js"

describe("auth routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("auth")
  })

  it("signs up and returns a token + profile", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ username: "newuser1", email: "new1@test.local", password: "Password12", name: "New" })
    expect(res.status).toBe(201)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.username).toBe("newuser1")
    expect(res.body.user.name).toBe("New")
  })

  it("rejects duplicate usernames and emails with one indistinguishable 409", async () => {
    const dupUser = await request(app)
      .post("/api/auth/signup")
      .send({ username: u.username, email: "other@test.local", password: "Password12" })
    expect(dupUser.status).toBe(409)

    const dupEmail = await request(app)
      .post("/api/auth/signup")
      .send({ username: "duptest99", email: `${u.username}@test.local`, password: "Password12" })
    expect(dupEmail.status).toBe(409)

    // Same message and code either way: signup must not say which addresses
    // have an account.
    expect(dupEmail.body.error).toBe(dupUser.body.error)
    expect(dupEmail.body.code).toBe("ACCOUNT_UNAVAILABLE")
    expect(dupUser.body.code).toBe("ACCOUNT_UNAVAILABLE")
  })

  it("enforces the new-password policy at signup: 8+ chars, at most 72 bytes", async () => {
    const short = await request(app)
      .post("/api/auth/signup")
      .send({ username: "shortpw1", email: "shortpw1@test.local", password: "Passw0r" })
    expect(short.status).toBe(400)

    // 36 two-byte characters plus a digit is 37 characters but 73 bytes.
    const long = await request(app)
      .post("/api/auth/signup")
      .send({ username: "longpw1", email: "longpw1@test.local", password: "é".repeat(36) + "a1" })
    expect(long.status).toBe(400)
  })

  it("rejects invalid signups with 400 + details", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ username: "x", email: "bad", password: "weak" })
    expect(res.status).toBe(400)
    expect(Array.isArray(res.body.details)).toBe(true)
  })

  it("signs in with correct credentials, rejects bad ones", async () => {
    const good = await request(app)
      .post("/api/auth/signin")
      .send({ username: u.username, password: "Passw0rd-123" })
    expect(good.status).toBe(200)
    expect(good.body.token).toBeTruthy()

    const badPw = await request(app)
      .post("/api/auth/signin")
      .send({ username: u.username, password: "WrongPass1" })
    expect(badPw.status).toBe(401)

    const noUser = await request(app)
      .post("/api/auth/signin")
      .send({ username: "ghost123", password: "WrongPass1" })
    expect(noUser.status).toBe(401)
  })

  it("GET /me returns the profile, 401 without a token", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401)
    const res = await request(app).get("/api/auth/me").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe(u.username)
  })

  it("PUT /profile updates name/email and reports no-op", async () => {
    const noop = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({})
    expect(noop.status).toBe(200)
    expect(noop.body.message).toBe("No changes provided")

    const upd = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({ name: "Auth Test User" })
    expect(upd.status).toBe(200)
    expect(upd.body.user.name).toBe("Auth Test User")

    const bad = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({ email: "not-an-email" })
    expect(bad.status).toBe(400)
  })

  it("POST /refresh without a refresh token is refused: an access token can't renew itself", async () => {
    const res = await request(app).post("/api/auth/refresh").set(auth(u.token))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe("REFRESH_TOKEN_REQUIRED")
  })

  it("POST /refresh keeps the legacy bearer path behind AUTH_LEGACY_REFRESH", async () => {
    process.env.AUTH_LEGACY_REFRESH = "true"
    try {
      const res = await request(app).post("/api/auth/refresh").set(auth(u.token))
      expect(res.status).toBe(200)
      const me = await request(app).get("/api/auth/me").set(auth(res.body.token))
      expect(me.status).toBe(200)
    } finally {
      delete process.env.AUTH_LEGACY_REFRESH
    }
  })

  it("rotates the refresh token, and a replay kills the whole family", async () => {
    const signin = await request(app)
      .post("/api/auth/signin")
      .send({ username: u.username, password: u.password })
    const first = signin.body.refreshToken
    expect(typeof first).toBe("string")

    const rotated = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: first })
    expect(rotated.status).toBe(200)
    expect(rotated.body.refreshToken).toBeTruthy()
    expect(rotated.body.refreshToken).not.toBe(first)

    const me = await request(app)
      .get("/api/auth/me")
      .set(auth(rotated.body.token))
    expect(me.status).toBe(200)

    // Replaying the spent token is the leak signal: 401 + REFRESH_REUSED, and
    // the replacement dies with it.
    const replay = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: first })
    expect(replay.status).toBe(401)
    expect(replay.body.code).toBe("REFRESH_REUSED")

    const dead = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: rotated.body.refreshToken })
    expect(dead.status).toBe(401)
    expect(dead.body.code).toBeUndefined()
  })

  it("rejects an unknown refresh token without a reuse code", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "nope" })
    expect(res.status).toBe(401)
    expect(res.body.code).toBeUndefined()
  })

  it("POST /signout revokes the token and stays 204 for unknown ones", async () => {
    const signin = await request(app)
      .post("/api/auth/signin")
      .send({ username: u.username, password: u.password })
    const { token, refreshToken } = signin.body

    const out = await request(app)
      .post("/api/auth/signout")
      .set(auth(token))
      .send({ refreshToken })
    expect(out.status).toBe(204)

    const after = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken })
    expect(after.status).toBe(401)

    const unknown = await request(app)
      .post("/api/auth/signout")
      .set(auth(token))
      .send({ refreshToken: "never-existed" })
    expect(unknown.status).toBe(204)

    expect(
      (await request(app).post("/api/auth/signout").send({ refreshToken })).status,
    ).toBe(401)
  })

  it("POST /signout allDevices kills live access tokens and hands this device a fresh pair", async () => {
    const s = await signup("outall")
    const other = await request(app)
      .post("/api/auth/signin")
      .send({ username: s.username, password: s.password })
    expect(other.status).toBe(200)

    const out = await request(app)
      .post("/api/auth/signout")
      .set(auth(s.token))
      .send({ allDevices: true })
    expect(out.status).toBe(200)
    expect(out.body.token).toBeTruthy()
    expect(out.body.refreshToken).toBeTruthy()

    // Every access token issued before (this device's and the other's) is dead...
    expect((await request(app).get("/api/auth/me").set(auth(s.token))).status).toBe(401)
    expect((await request(app).get("/api/auth/me").set(auth(other.body.token))).status).toBe(401)
    // ...so is the other device's refresh token...
    expect(
      (await request(app).post("/api/auth/refresh").send({ refreshToken: other.body.refreshToken })).status,
    ).toBe(401)
    // ...and the caller carries on with the pair it got back.
    expect((await request(app).get("/api/auth/me").set(auth(out.body.token))).status).toBe(200)
    expect(
      (await request(app).post("/api/auth/refresh").send({ refreshToken: out.body.refreshToken })).status,
    ).toBe(200)
  })

  it("backs off signin per username after repeated failures, for real and unknown names alike", async () => {
    const t = await signup("throt")
    for (let i = 0; i < 5; i++) {
      const miss = await request(app)
        .post("/api/auth/signin")
        .send({ username: t.username, password: "WrongPass12" })
      expect(miss.status).toBe(401)
    }
    // The 6th miss is still answered, and starts the lockout.
    expect(
      (await request(app).post("/api/auth/signin").send({ username: t.username, password: "WrongPass12" })).status,
    ).toBe(401)
    // Locked: even the right password waits, keyed case-insensitively.
    const locked = await request(app)
      .post("/api/auth/signin")
      .send({ username: t.username.toUpperCase(), password: t.password })
    expect(locked.status).toBe(429)
    expect(locked.body.code).toBe("AUTH_THROTTLED")
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0)

    // An unknown name locks exactly the same way, so the lock says nothing
    // about whether an account exists.
    for (let i = 0; i < 6; i++)
      await request(app).post("/api/auth/signin").send({ username: "ghost_throt", password: "WrongPass12" })
    expect(
      (await request(app).post("/api/auth/signin").send({ username: "ghost_throt", password: "WrongPass12" })).status,
    ).toBe(429)

    // Other accounts are unaffected.
    expect(
      (await request(app).post("/api/auth/signin").send({ username: u.username, password: u.password })).status,
    ).toBe(200)
  })

  it("rejects non-string credentials with 400", async () => {
    const res = await request(app)
      .post("/api/auth/signin")
      .send({ username: { $gt: "" }, password: "x" })
    expect(res.status).toBe(400)
  })

  it("PUT /profile needs the current password to change email", async () => {
    const e = await signup("emailch")
    const other = await signup("emailtk")

    const none = await request(app)
      .put("/api/auth/profile")
      .set(auth(e.token))
      .send({ email: "changed@test.local" })
    expect(none.status).toBe(400)
    expect(none.body.code).toBe("CURRENT_PASSWORD_REQUIRED")

    const wrong = await request(app)
      .put("/api/auth/profile")
      .set(auth(e.token))
      .send({ email: "changed@test.local", currentPassword: "WrongPass12" })
    expect(wrong.status).toBe(403)

    // Re-sending the current address is not a change and needs nothing.
    const same = await request(app)
      .put("/api/auth/profile")
      .set(auth(e.token))
      .send({ email: `${e.username}@test.local`, name: "Same Email" })
    expect(same.status).toBe(200)

    const taken = await request(app)
      .put("/api/auth/profile")
      .set(auth(e.token))
      .send({ email: `${other.username}@test.local`, currentPassword: e.password })
    expect(taken.status).toBe(409)
    expect(taken.body.code).toBe("ACCOUNT_UNAVAILABLE")

    const ok = await request(app)
      .put("/api/auth/profile")
      .set(auth(e.token))
      .send({ email: `${e.username}-new@test.local`, currentPassword: e.password })
    expect(ok.status).toBe(200)
    expect(ok.body.user.email).toBe(`${e.username}-new@test.local`)
  })

  it("PUT /password verifies the current one, revokes old tokens", async () => {
    const wrong = await request(app)
      .put("/api/auth/password")
      .set(auth(u.token))
      .send({ currentPassword: "WrongPass1", newPassword: "Password22" })
    expect(wrong.status).toBe(403)

    const weak = await request(app)
      .put("/api/auth/password")
      .set(auth(u.token))
      .send({ currentPassword: "Passw0rd-123", newPassword: "weak" })
    expect(weak.status).toBe(400)

    const ok = await request(app)
      .put("/api/auth/password")
      .set(auth(u.token))
      .send({ currentPassword: "Passw0rd-123", newPassword: "Password22" })
    expect(ok.status).toBe(200)
    expect(ok.body.token).toBeTruthy()

    const revoked = await request(app).get("/api/auth/me").set(auth(u.token))
    expect(revoked.status).toBe(401)

    const fresh = await request(app).get("/api/auth/me").set(auth(ok.body.token))
    expect(fresh.status).toBe(200)
    u = { ...u, token: ok.body.token, password: "Password22" }
  })

  it("GET /account/export returns everything the server holds", async () => {
    const res = await request(app).get("/api/auth/account/export").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.data.profile.username).toBe(u.username)
  })

  it("GET /account/export includes rows keyed by a parent, not the user", async () => {
    const x = await signup("expch")
    const post = (url: string, body: object) =>
      request(app).post(url).set(auth(x.token)).send(body)

    const session = await post("/api/sessions/start", { dayNumber: 1, dayTitle: "Day 1", split: "A" })
    const now = Date.now()
    await post(`/api/sessions/${session.body.session.id}/set`, {
      exerciseName: "Bench",
      setIndex: 1,
      startTime: new Date(now - 60_000).toISOString(),
      endTime: new Date(now - 30_000).toISOString(),
      weight: 60,
      reps: 8,
    })
    await post("/api/program/upload", {
      originalFilename: "plan.csv",
      weeklyPlan: {
        split: ["push"],
        days: [
          {
            dayNumber: 1,
            dayTitle: "Push",
            exercises: [{ name: "Bench", primaryMuscles: ["chest"], secondaryMuscles: [], setsBySplit: { push: 3 } }],
            split: { push: { exercises: [{ name: "Bench", sets: 3 }], totalSets: 3 } },
          },
        ],
      },
    })
    const sup = await post("/api/tracking/supplements", { name: "Creatine" })
    await post(`/api/tracking/supplements/${sup.body.supplement.id}/log`, { amount: 5 })
    const sore = await post("/api/tracking/soreness", { muscleGroup: "chest", intensity: 5 })
    await post(`/api/tracking/soreness/${sore.body.data.id}/follow-ups`, { intensity: 2, status: "better" })

    // Someone else's rows in the same child tables must stay out.
    const other = await signup("expot")
    await request(app).post("/api/sessions/start").set(auth(other.token)).send({ dayNumber: 1, dayTitle: "D", split: "A" })

    const res = await request(app).get("/api/auth/account/export").set(auth(x.token))
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.workout_sets).toHaveLength(1)
    expect(d.workout_sets[0].weight).toBe(60)
    expect(d.program_days).toHaveLength(1)
    expect(d.program_exercises.length).toBeGreaterThanOrEqual(1)
    expect(d.supplement_intake).toHaveLength(1)
    // The composite FK's user column is rewritten to the uuid like the rest.
    expect(d.supplement_intake[0].user_id).toBe(x.user.id)
    expect(d.soreness_follow_up).toHaveLength(1)
    expect(d.progress_photo_blobs).toBeUndefined()
  })

  it("DELETE /account/data requires the confirmation token and wipes data", async () => {
    const noConfirm = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({})
    expect(noConfirm.status).toBe(400)

    const wrongConfirm = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({ confirmDelete: "nope" })
    expect(wrongConfirm.status).toBe(400)

    const seed = await request(app)
      .post("/api/tracking/hydration")
      .set(auth(u.token))
      .send({ amountMl: 100 })
    expect(seed.status).toBe(201)

    const noPassword = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({ confirmDelete: "DELETE_ALL_DATA" })
    expect(noPassword.status).toBe(400)
    expect(noPassword.body.code).toBe("PASSWORD_REQUIRED")

    const wrongPassword = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({ confirmDelete: "DELETE_ALL_DATA", password: "WrongPass12" })
    expect(wrongPassword.status).toBe(403)

    const ok = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({ confirmDelete: "DELETE_ALL_DATA", password: u.password })
    expect(ok.status).toBe(200)

    const history = await request(app)
      .get("/api/tracking/hydration")
      .set(auth(u.token))
    expect(history.body.data.length).toBe(0)

    const stillIn = await request(app).get("/api/auth/me").set(auth(u.token))
    expect(stillIn.status).toBe(200)
  })

  it("DELETE /account/data takes no password only behind AUTH_LEGACY_DATA_WIPE", async () => {
    const w = await signup("legwipe")
    process.env.AUTH_LEGACY_DATA_WIPE = "true"
    try {
      const res = await request(app)
        .delete("/api/auth/account/data")
        .set(auth(w.token))
        .send({ confirmDelete: "DELETE_ALL_DATA" })
      expect(res.status).toBe(200)
      // A password that is sent is still checked.
      const wrong = await request(app)
        .delete("/api/auth/account/data")
        .set(auth(w.token))
        .send({ confirmDelete: "DELETE_ALL_DATA", password: "WrongPass12" })
      expect(wrong.status).toBe(403)
    } finally {
      delete process.env.AUTH_LEGACY_DATA_WIPE
    }
  })

  it("Clear All Data keeps the reports the user filed, without their name", async () => {
    const r = await signup("wiperep")
    const t = await signup("wipetgt")
    const filed = await request(app)
      .post("/api/friends/report")
      .set(auth(r.token))
      .send({ userId: t.user.id, reason: "spam", details: "wipe-kept" })
    expect(filed.status).toBe(201)

    const wipe = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(r.token))
      .send({ confirmDelete: "DELETE_ALL_DATA", password: r.password })
    expect(wipe.status).toBe(200)

    const [rows] = await pool.query<any[]>(
      "SELECT reporter_id FROM user_reports WHERE details = 'wipe-kept'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].reporter_id).toBeNull()
  })

  // getUserOwnedTables() discovers every table with a user column, so the two
  // tables that replaced hydration_settings/menstrual_settings/macros_goals and
  // the custom-measurement pair have to show up without anyone listing them.
  it("exports and wipes the settings and measurement tables too", async () => {
    const v = await signup("wipeall")

    expect(
      (await request(app).patch("/api/settings").set(auth(v.token)).send({
        hydrationGoalMl: 3000, cyclePeriodDays: 6, cycleLengthDays: 30,
      })).status,
    ).toBe(200)
    const def = await request(app)
      .post("/api/tracking/measurements/definitions")
      .set(auth(v.token))
      .send({ keyName: "forearm_cm", label: "Forearm", unit: "cm" })
    expect(def.status).toBe(201)
    expect(
      (await request(app).post("/api/tracking/measurements").set(auth(v.token)).send({ values: { forearm_cm: 31.5 } })).status,
    ).toBe(201)

    const tables = ["user_settings", "metric_definitions", "measurements"]

    const exported = await request(app).get("/api/auth/account/export").set(auth(v.token))
    for (const table of tables) expect(exported.body.data[table]).toHaveLength(1)

    expect(
      (await request(app).delete("/api/auth/account/data").set(auth(v.token)).send({ confirmDelete: "DELETE_ALL_DATA", password: v.password })).status,
    ).toBe(200)

    const after = await request(app).get("/api/auth/account/export").set(auth(v.token))
    for (const table of tables) expect(after.body.data[table]).toHaveLength(0)
  })

  it("export names other users by uuid, never by internal id", async () => {
    const x = await signup("expx")
    const y = await signup("expy")
    const req = await request(app).post("/api/friends/request").set(auth(x.token)).send({ username: y.username })
    expect(req.status).toBe(201)

    const exported = await request(app).get("/api/auth/account/export").set(auth(x.token))
    const [row] = exported.body.data.friendships
    expect([row.user_id, row.friend_id].sort()).toEqual([x.user.id, y.user.id].sort())
    expect(row.requested_by).toBe(x.user.id)
  })

  it("PUT /profile stores height, which the export reads back", async () => {
    const h = await signup("heighty")

    const bad = await request(app).put("/api/auth/profile").set(auth(h.token)).send({ heightCm: 400 })
    expect(bad.status).toBe(400)

    const ok = await request(app).put("/api/auth/profile").set(auth(h.token)).send({ heightCm: 182 })
    expect(ok.status).toBe(200)

    const exported = await request(app).get("/api/auth/account/export").set(auth(h.token))
    expect(Number(exported.body.data.profile.height_cm)).toBe(182)
  })

  it("DELETE /account re-checks the password, then deletes", async () => {
    const res = await signup("delme")

    const wrongPw = await request(app)
      .delete("/api/auth/account")
      .set(auth(res.token))
      .send({ password: "WrongPass1" })
    expect(wrongPw.status).toBe(403)

    const ok = await request(app)
      .delete("/api/auth/account")
      .set(auth(res.token))
      .send({ password: "Passw0rd-123" })
    expect(ok.status).toBe(200)

    const me = await request(app).get("/api/auth/me").set(auth(res.token))
    expect(me.status).toBe(401)
  })

  it("re-deletes an account that a backup restore brings back", async () => {
    const res = await signup("restored")
    const [[row]] = await pool.query<any[]>("SELECT * FROM users WHERE uuid = ?", [res.user.id])

    await request(app)
      .delete("/api/auth/account")
      .set(auth(res.token))
      .send({ password: res.password })
      .expect(200)

    // Simulate restoring a backup taken before the deletion.
    await pool.query("INSERT INTO users SET ?", [row])
    expect(await purgeDeletedAccounts()).toBe(1)
    const [left] = await pool.query<any[]>("SELECT 1 FROM users WHERE uuid = ?", [res.user.id])
    expect(left).toHaveLength(0)
    const [tomb] = await pool.query<any[]>("SELECT 1 FROM deleted_accounts WHERE uuid = ?", [res.user.id])
    expect(tomb).toHaveLength(1)
  })
})
