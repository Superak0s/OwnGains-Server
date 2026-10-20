import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { pool } from "@/config/database.js"
import type { RowDataPacket } from "mysql2"

const owner = async (token: string) => {
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT user_id FROM push_tokens WHERE token = ?", [token])
  return rows[0]?.user_id ?? null
}

describe("push routes", () => {
  it("registers, moves and removes a device token", async () => {
    const a = await signup("pusha")
    const b = await signup("pushb")
    const put = (t: string, body: object) => request(app).put("/api/push/token").set(auth(t)).send(body)

    expect((await put(a.token, {})).status).toBe(400)
    expect((await put(a.token, { token: "x".repeat(256) })).status).toBe(400)

    const res = await put(a.token, { token: "dev-1" })
    expect(res.body).toEqual({ success: true, enabled: true })
    expect(await owner("dev-1")).toBe(await internalId(a.user.id))

    await put(b.token, { token: "dev-1" })
    expect(await owner("dev-1")).toBe(await internalId(b.user.id))

    // A device whose session was revoked can still stop its pushes, holding only the token.
    expect((await request(app).delete("/api/push/token").send({})).status).toBe(400)
    expect((await request(app).delete("/api/push/token").send({ token: "dev-1" })).status).toBe(200)
    expect(await owner("dev-1")).toBeNull()
    expect((await request(app).put("/api/push/token").send({ token: "dev-1" })).status).toBe(401)
  })

  it("drops the tokens with the account", async () => {
    const a = await signup("pushc")
    await request(app).put("/api/push/token").set(auth(a.token)).send({ token: "dev-2" })
    await request(app).delete("/api/auth/account").set(auth(a.token)).send({ password: a.password })
    expect(await owner("dev-2")).toBeNull()
  })
})
