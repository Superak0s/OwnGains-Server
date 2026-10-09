// Auth route branches the main suites don't reach.
import { describe, it, expect, afterEach, vi } from "vitest"
import request from "supertest"
import { pool } from "@/config/database.js"
import { setUserDisabled } from "../auth.model.js"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"

afterEach(() => vi.restoreAllMocks())

describe("auth route edges", () => {
  it("passes on a throttle lookup that fails without a Retry-After", async () => {
    const u = await signup("authth")
    const real = pool.execute.bind(pool)
    vi.spyOn(pool, "execute").mockImplementation(((sql: string, p: unknown) =>
      sql.includes("auth_throttle") ? Promise.reject(new Error("down")) : real(sql, p as never)) as never)
    const res = await request(app).post("/api/auth/signin").send({ username: u.username, password: "Passw0rd-123" })
    expect(res.status).toBe(500)
    expect(res.headers["retry-after"]).toBeUndefined()
  })

  it("names no reason for a suspension given none", async () => {
    const u = await signup("authsus")
    await setUserDisabled(await internalId(u.user.id), true)
    const res = await request(app).post("/api/auth/signin").send({ username: u.username, password: "Passw0rd-123" })
    expect(res.body.error).toContain("Reason: not given")
  })

  it("rejects an unknown formula sex, and signs out without a refresh token", async () => {
    const u = await signup("authbf")
    const bad = await request(app).put("/api/auth/profile").set(auth(u.token)).send({ bfFormulaSex: "x" })
    expect(bad.status).toBe(400)
    expect((await request(app).post("/api/auth/signout").set(auth(u.token)).send({})).status).toBe(204)
  })
})
