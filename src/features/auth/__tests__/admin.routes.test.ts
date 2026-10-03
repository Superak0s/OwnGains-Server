import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import { createUser, findUserByUsername } from "../auth.model.js"

describe("admin routes and moderation", () => {
  let admin: Awaited<ReturnType<typeof signup>>
  let plain: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    admin = await signup("admn")
    plain = await signup("plain")
    // isAdmin is read from the row on every request, so the existing token
    // picks this up without re-signing in.
    await pool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [await internalId(admin.user.id)])
  })

  // __tests__/owngains.test.ts briefly demotes every other admin to test the
  // CLI's last-admin guard. Re-assert before each test so that window can't
  // turn into a stray 403 here.
  beforeEach(async () => {
    await pool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [await internalId(admin.user.id)])
  })

  it("refuses non-admins and anonymous callers", async () => {
    expect((await request(app).get("/api/admin/reports")).status).toBe(401)
    expect((await request(app).get("/api/admin/reports").set(auth(plain.token))).status).toBe(403)
    expect(
      (await request(app).post(`/api/admin/users/${admin.user.id}/suspend`).set(auth(plain.token))).status,
    ).toBe(403)
  })

  it("keeps a report, with who it was about, after the reported account is deleted", async () => {
    const reporter = await signup("rptr")
    const target = await signup("rptd")
    const filed = await request(app)
      .post("/api/friends/report")
      .set(auth(reporter.token))
      .send({ userId: target.user.id, reason: "harassment", details: "kept" })
    expect(filed.status).toBe(201)

    const del = await request(app)
      .delete("/api/auth/account")
      .set(auth(target.token))
      .send({ password: target.password })
    expect(del.status).toBe(200)

    const list = await request(app).get("/api/admin/reports?limit=500").set(auth(admin.token))
    expect(list.status).toBe(200)
    const report = list.body.reports.find((r: any) => r.details === "kept")
    expect(report).toBeTruthy()
    expect(report.reported).toMatchObject({
      id: target.user.id,
      username: target.username,
      deleted: true,
    })
    expect(report.reporter.username).toBe(reporter.username)
  })

  it("suspends an account everywhere, and unsuspends it", async () => {
    const v = await signup("susp")
    const signin = await request(app)
      .post("/api/auth/signin")
      .send({ username: v.username, password: v.password })
    const { refreshToken } = signin.body

    const noReason = await request(app).post(`/api/admin/users/${v.user.id}/suspend`).set(auth(admin.token))
    expect(noReason.status).toBe(400)

    const res = await request(app)
      .post(`/api/admin/users/${v.user.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: "Spam reports" })
    expect(res.status).toBe(200)

    // Existing access token, refresh token and a fresh signin all refused.
    expect((await request(app).get("/api/auth/me").set(auth(v.token))).status).toBe(401)
    expect((await request(app).post("/api/auth/refresh").send({ refreshToken })).status).toBe(401)
    const blocked = await request(app)
      .post("/api/auth/signin")
      .send({ username: v.username, password: v.password })
    expect(blocked.status).toBe(403)
    expect(blocked.body.code).toBe("ACCOUNT_DISABLED")
    expect(JSON.stringify(blocked.body)).toContain("Spam reports")
    // A wrong password gets the ordinary 401, so suspension can't be probed.
    expect(
      (await request(app).post("/api/auth/signin").send({ username: v.username, password: "WrongPass12" })).status,
    ).toBe(401)

    // Hidden from search while suspended.
    const search = await request(app).get(`/api/friends/search?q=${v.username}`).set(auth(plain.token))
    expect(search.body.users).toHaveLength(0)

    const un = await request(app).post(`/api/admin/users/${v.user.id}/unsuspend`).set(auth(admin.token))
    expect(un.status).toBe(200)
    expect(
      (await request(app).post("/api/auth/signin").send({ username: v.username, password: v.password })).status,
    ).toBe(200)
  })

  it("won't suspend an admin", async () => {
    const res = await request(app)
      .post(`/api/admin/users/${admin.user.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: "x" })
    expect(res.status).toBe(403)
  })
})

describe("BOOTSTRAP_ADMIN_USERNAME", () => {
  it("makes only the named user admin when set", async () => {
    process.env.BOOTSTRAP_ADMIN_USERNAME = "BootAdmin_x1"
    try {
      await createUser("bootadmin_x1", "bootadmin_x1@test.local", "Passw0rd-123")
      await createUser("bootother_x1", "bootother_x1@test.local", "Passw0rd-123")
      expect((await findUserByUsername("bootadmin_x1"))!.isAdmin).toBe(true)
      expect((await findUserByUsername("bootother_x1"))!.isAdmin).toBe(false)
    } finally {
      delete process.env.BOOTSTRAP_ADMIN_USERNAME
    }
  })
})
