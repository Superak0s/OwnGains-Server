import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"
import type { RowDataPacket } from "mysql2"
import { pool } from "../../../config/database.js"

describe("workout lifecycle", () => {
  let a: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    a = await signup("wolife")
  })

  it("ends once and ignores a replayed end", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 1, dayTitle: "Push", split: "push" })
    const id = start.body.session.id

    const first = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({})
    expect(first.status).toBe(200)
    expect(first.body.alreadyEnded).toBe(false)

    // The replay a client makes after a week offline: it must not rewrite
    // end_time and turn a short workout into a multi-day one.
    const replay = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({ endTime: new Date(Date.now() - 3600_000).toISOString() })
    expect(replay.status).toBe(200)
    expect(replay.body.alreadyEnded).toBe(true)
    expect(replay.body.session.endTime).toBe(first.body.session.endTime)
    expect(replay.body.session.totalDuration).toBe(
      first.body.session.totalDuration,
    )

    // endTime goes through the same bound as every client timestamp.
    const future = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({ endTime: new Date(Date.now() + 6 * 86400_000).toISOString() })
    expect(future.status).toBe(400)
    const notADate = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({ endTime: 12345 })
    expect(notADate.status).toBe(400)

    // A set posted after the end is kept (an offline phone replaying its
    // queue), and the workout's end moves forward to cover it.
    const late = await request(app)
      .post(`/api/sessions/${id}/set`)
      .set(auth(a.token))
      .send({
        exerciseName: "Bench Press",
        setIndex: 0,
        startTime: "2024-02-01T09:00:00Z",
        endTime: "2024-02-01T09:00:30Z",
        weight: 60,
        reps: 8,
      })
    expect(late.status).toBe(200)
    const [[row]] = await pool.execute<(RowDataPacket & { end_time: string; completed_sets: number })[]>(
      "SELECT end_time, completed_sets FROM workouts WHERE id = ?",
      [id],
    )
    expect(new Date(`${row.end_time}Z`).getTime()).toBeGreaterThanOrEqual(
      Date.parse("2024-02-01T09:00:30Z"),
    )
    expect(row.completed_sets).toBeGreaterThanOrEqual(1)
  })

  it("rejects an end before the workout started", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 2, dayTitle: "Pull", split: "pull" })
    const id = start.body.session.id

    const backwards = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({ endTime: "2020-01-01T00:00:00Z" })
    expect(backwards.status).toBe(400)

    await request(app).post(`/api/sessions/${id}/end`).set(auth(a.token)).send({})
  })

  it("moves a session to another day and refuses someone else's", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 1, dayTitle: "Push", split: "push" })
    const id = start.body.session.id

    const moved = await request(app)
      .patch(`/api/sessions/${id}`)
      .set(auth(a.token))
      .send({ dayNumber: 3, dayTitle: "Legs" })
    expect(moved.status).toBe(200)
    expect(moved.body.session.dayNumber).toBe(3)
    expect(moved.body.session.dayTitle).toBe("Legs")

    const untitled = await request(app)
      .patch(`/api/sessions/${id}`)
      .set(auth(a.token))
      .send({ dayNumber: 2 })
    expect(untitled.body.session.dayTitle).toBeNull()

    const bad = await request(app)
      .patch(`/api/sessions/${id}`)
      .set(auth(a.token))
      .send({ dayNumber: 0 })
    expect(bad.status).toBe(400)

    const other = await signup("wolife2")
    const foreign = await request(app)
      .patch(`/api/sessions/${id}`)
      .set(auth(other.token))
      .send({ dayNumber: 2 })
    expect(foreign.body.code).toBe("SESSION_NOT_FOUND")

    await request(app).post(`/api/sessions/${id}/end`).set(auth(a.token)).send({})
  })
})
