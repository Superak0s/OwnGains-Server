import { describe, it, expect, beforeAll } from "vitest"
import { createHash } from "node:crypto"
import request from "supertest"
import { pool } from "../../../config/database.js"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { purgeExpiredIdempotencyKeys } from "../../../middleware/idempotency.js"

describe("Idempotency-Key in-flight lock", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("idem")
  })

  it("runs concurrent retries of one key exactly once", async () => {
    const key = `race-${Date.now()}`
    const split = `race${Date.now()}`
    const body = { dayNumber: 1, dayTitle: "Race", split }
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app)
          .post("/api/sessions/start")
          .set(auth(u.token))
          .set("Idempotency-Key", key)
          .send(body),
      ),
    )
    const ok = results.filter((r) => r.status === 200)
    const inFlight = results.filter((r) => r.status === 409)
    expect(ok.length + inFlight.length).toBe(results.length)
    inFlight.forEach((r) => expect(r.body.code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT"))
    // Every 200 is the same response: one run, the rest replays.
    expect(new Set(ok.map((r) => r.body.session.id)).size).toBe(1)

    const list = await request(app).get(`/api/sessions?split=${split}`).set(auth(u.token))
    expect(list.body.sessions).toHaveLength(1)
    await request(app).post(`/api/sessions/${ok[0].body.session.id}/end`).set(auth(u.token)).send({})
  })

  it("takes over a placeholder abandoned by a request that died, and expired keys", async () => {
    const userId = await internalId(u.user.id)
    const body = { dayNumber: 1, dayTitle: "Takeover", split: `take${Date.now()}` }
    const route = "POST /api/sessions/start"

    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex")
    const placeholder = (key: string, minutesAgo: number) =>
      pool.execute(
        `INSERT INTO idempotency_keys (user_id, actor_id, idem_key, route, body_hash, status, response, created_at)
         VALUES (?, 0, ?, ?, ?, 0, '', UTC_TIMESTAMP() - INTERVAL ? MINUTE)`,
        [userId, key, route, hash, minutesAgo],
      )

    // A request still running holds its key.
    const busy = `busy-${Date.now()}`
    await placeholder(busy, 0)
    const blocked = await request(app)
      .post("/api/sessions/start")
      .set(auth(u.token))
      .set("Idempotency-Key", busy)
      .send(body)
    expect(blocked.status).toBe(409)
    expect(blocked.headers["retry-after"]).toBe("2")

    // A crash mid-request leaves a placeholder behind. Once stale, a retry
    // takes it over and runs.
    const stuck = `stuck-${Date.now()}`
    await placeholder(stuck, 10)
    const retried = await request(app)
      .post("/api/sessions/start")
      .set(auth(u.token))
      .set("Idempotency-Key", stuck)
      .send(body)
    expect(retried.status).toBe(200)
    await request(app)
      .post(`/api/sessions/${retried.body.session.id}/end`)
      .set(auth(u.token))
      .send({})

    await pool.execute(
      `UPDATE idempotency_keys SET status = 200, response = '{}',
         created_at = UTC_TIMESTAMP() - INTERVAL 3 DAY
       WHERE user_id = ? AND idem_key = ?`,
      [userId, stuck],
    )
    const afterExpiry = await request(app)
      .post("/api/sessions/start")
      .set(auth(u.token))
      .set("Idempotency-Key", stuck)
      .send(body)
    expect(afterExpiry.status).toBe(200)
    expect(afterExpiry.body.session.id).toBeGreaterThan(0)
    await request(app)
      .post(`/api/sessions/${afterExpiry.body.session.id}/end`)
      .set(auth(u.token))
      .send({})
  })

  it("purges expired keys for every user", async () => {
    const userId = await internalId(u.user.id)
    await pool.execute(
      `INSERT INTO idempotency_keys (user_id, actor_id, idem_key, route, body_hash, status, response, created_at)
       VALUES (?, 0, ?, 'r', 'x', 200, '{}', UTC_TIMESTAMP() - INTERVAL 3 DAY)`,
      [userId, `old-${Date.now()}`],
    )
    expect(await purgeExpiredIdempotencyKeys()).toBeGreaterThanOrEqual(1)
    const [rows] = await pool.query(
      `SELECT 1 FROM idempotency_keys WHERE created_at <= UTC_TIMESTAMP() - INTERVAL 2 DAY`,
    )
    expect(rows).toHaveLength(0)
  })
})
