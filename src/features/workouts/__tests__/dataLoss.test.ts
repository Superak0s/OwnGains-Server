import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import type { RowDataPacket } from "mysql2"
import { pool } from "../../../config/database.js"
import { endStaleSessions } from "../workouts.model.js"

// Data-loss audit: each case fails while the loss it describes is possible.
describe("workout data loss", () => {
  it("keeps a set logged offline that replays after the auto-end sweep", async () => {
    const u = await signup("dlate")
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(u.token))
      .send({ dayNumber: 1, dayTitle: "Push", split: "push" })
    const id = start.body.session.id

    // The phone lost signal 40 minutes ago and kept logging locally. The
    // server last saw the start, so the next sweep closes the workout.
    await pool.execute(
      "UPDATE workouts SET start_time = NOW() - INTERVAL 40 MINUTE WHERE id = ?",
      [id],
    )
    await endStaleSessions(30)

    // Signal is back and the offline queue replays the set. The app's queue
    // drops it for good on SESSION_ALREADY_ENDED (useSyncManager isSessionGone).
    const now = Date.now()
    const set = await request(app)
      .post(`/api/sessions/${id}/set`)
      .set(auth(u.token))
      .set("Idempotency-Key", `late-${id}`)
      .send({
        exerciseName: "Bench Press",
        setIndex: 0,
        startTime: new Date(now - 60_000).toISOString(),
        endTime: new Date(now - 20_000).toISOString(),
        weight: 80,
        reps: 8,
      })
    expect(set.status).toBe(200)
    const [rows] = await pool.execute<(RowDataPacket & { n: number })[]>(
      "SELECT COUNT(*) AS n FROM workout_sets WHERE workout_id = ?",
      [id],
    )
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it("removing demo data keeps a height the user set after the fill", async () => {
    const u = await signup("ddemo")
    const fill = await request(app)
      .post("/api/sessions/demo")
      .set(auth(u.token))
      .send({
        days: [
          { dayNumber: 1, dayTitle: "Push", exercises: [{ name: "Bench Press", sets: 2 }] },
        ],
      })
    expect(fill.status).toBe(200)

    // The user enters their real height while the demo is still loaded.
    const put = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({ heightCm: 182 })
    expect(put.status).toBe(200)

    await request(app).delete("/api/sessions/demo").set(auth(u.token)).expect(200)

    const [rows] = await pool.execute<(RowDataPacket & { height_cm: number | null })[]>(
      "SELECT height_cm FROM users WHERE id = ?",
      [await internalId(u.user.id)],
    )
    expect(Number(rows[0]!.height_cm)).toBe(182)
  })
})
