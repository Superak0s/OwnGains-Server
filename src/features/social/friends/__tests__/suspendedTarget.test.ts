// Data-isolation regression: search hides suspended accounts, so a friend
// request must too, or 201 vs 404 tells a stranger the name exists.
import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth, uniqueName } from "../../../../tests/helpers.js"
import { pool } from "@/config/database.js"

describe("friend request to a suspended account", () => {
  it("answers exactly like a username that does not exist", async () => {
    const prober = await signup("susp")
    const target = await signup("sust")
    await pool.execute("UPDATE users SET disabled_at = NOW() WHERE uuid = ?", [target.user.id])

    const missing = await request(app)
      .post("/api/friends/request")
      .set(auth(prober.token))
      .send({ username: uniqueName("nobody") })
    const suspended = await request(app)
      .post("/api/friends/request")
      .set(auth(prober.token))
      .send({ username: target.username })

    expect(missing.status).toBe(404)
    expect(suspended.status).toBe(missing.status)
  })
})
