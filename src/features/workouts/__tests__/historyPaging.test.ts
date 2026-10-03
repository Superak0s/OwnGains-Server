import { describe, it, expect, beforeAll, onTestFinished } from "vitest"
import request from "supertest"
import { pool } from "../../../config/database.js"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"

describe("GET /api/sessions paging", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("page")
    const userId = await internalId(u.user.id)
    // 105 closed workouts, with pairs sharing a start_time so the id
    // tie-break is exercised.
    const base = Date.UTC(2024, 2, 1)
    const values = Array.from({ length: 105 }, (_, i) => [
      userId,
      1,
      `W${i}`,
      "paging",
      new Date(base + Math.floor(i / 2) * 60_000).toISOString().slice(0, 19).replace("T", " "),
    ])
    await pool.query(
      `INSERT INTO workouts (user_id, day_number, day_title, split, start_time) VALUES ?`,
      [values],
    )
    await pool.execute(
      `UPDATE workouts SET end_time = start_time, total_duration = 0 WHERE user_id = ?`,
      [userId],
    )
  })

  it("walks the whole history with nextCursor, without gaps or repeats", async () => {
    const seen: number[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res: request.Response = await request(app)
        .get("/api/sessions")
        .query({ limit: 7, ...(cursor ? { before: cursor } : {}) })
        .set(auth(u.token))
      expect(res.status).toBe(200)
      seen.push(...res.body.sessions.map((s: { id: number }) => s.id))
      cursor = res.body.nextCursor
      pages++
    } while (cursor && pages < 50)

    expect(seen).toHaveLength(105)
    expect(new Set(seen).size).toBe(105)

    const all = await request(app).get("/api/sessions?limit=365").set(auth(u.token))
    expect(all.body.sessions.map((s: { id: number }) => s.id)).toEqual(seen)
    expect(all.body.nextCursor).toBeNull()
  })

  it("caps a page with timings at HISTORY_TIMINGS_MAX and rejects a malformed cursor", async () => {
    process.env.HISTORY_TIMINGS_MAX = "100"
    onTestFinished(() => {
      delete process.env.HISTORY_TIMINGS_MAX
    })
    const big = await request(app)
      .get("/api/sessions?includeTimings=true&limit=1000")
      .set(auth(u.token))
    expect(big.status).toBe(200)
    expect(big.body.sessions).toHaveLength(100)
    expect(typeof big.body.nextCursor).toBe("string")

    const rest = await request(app)
      .get("/api/sessions")
      .query({ includeTimings: "true", limit: 1000, before: big.body.nextCursor })
      .set(auth(u.token))
    expect(rest.body.sessions).toHaveLength(5)
    expect(rest.body.nextCursor).toBeNull()

    for (const before of ["nope", "2024-03-01 10:00:00", "2024-03-01 10:00:00,0", "x,1"]) {
      const bad = await request(app).get("/api/sessions").query({ before }).set(auth(u.token))
      expect(bad.status, before).toBe(400)
    }
  })
})
