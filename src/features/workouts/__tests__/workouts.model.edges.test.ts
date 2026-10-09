// The model's less travelled paths, called directly: trainer conflicts, every
// editable set field, record chunking past one IN list, and the stale sweep's
// full batches and rollback.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import type { PoolConnection } from "mysql2/promise"
import { signup, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import * as w from "../workouts.model.js"

afterEach(() => vi.restoreAllMocks())

const set = (extra: Record<string, unknown> = {}) => ({
  exerciseName: "EdgeRow",
  setIndex: 0,
  startTime: "2026-01-01T10:00:00Z",
  endTime: "2026-01-01T10:01:00Z",
  weight: 50,
  reps: 8,
  ...extra,
})

describe("workouts model edges", () => {
  let userId: number
  let other: number

  beforeAll(async () => {
    userId = await internalId((await signup("wedge")).user.id)
    other = await internalId((await signup("wedge2")).user.id)
  })

  it("tells a trainer an ended workout from someone else's", async () => {
    const id = await w.createSession(userId, 1, "D", "2026-01-01T09:00:00Z")
    await w.endSession(id, userId)
    await expect(w.recordSetTiming(id, userId, set(), { openWorkoutOnly: true })).rejects.toMatchObject({
      code: "SESSION_ALREADY_ENDED",
    })
    await expect(w.recordSetTiming(id, other, set(), { openWorkoutOnly: true })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    })
  })

  it("edits every field of a set, and rejects an end before the start", async () => {
    const id = await w.createSession(userId, 1, "D", "2026-01-01T09:00:00Z")
    const sid = (await w.recordSetTiming(id, userId, set())).id

    expect(await w.updateSetTiming(id, sid, userId, {})).toMatchObject({ weight: expect.anything() })
    const edited = await w.updateSetTiming(id, sid, userId, {
      exerciseName: "EdgePress",
      note: "n",
      isWarmup: true,
      machineName: "Rack",
      startTime: "2026-01-01T10:00:30Z",
    })
    expect(edited).toMatchObject({ exerciseName: "EdgePress", note: "n", machineName: "Rack", setDuration: 30 })
    await w.updateSetTiming(id, sid, userId, { exerciseName: "EdgePress", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], isWarmup: false })
    await expect(w.updateSetTiming(id, sid, userId, { endTime: "2026-01-01T09:00:00Z" })).rejects.toThrow(
      "Set end time cannot be before start time",
    )
  })

  it("renames nothing when nothing matches, and keeps the old name when no new one is given", async () => {
    expect(await w.renameExerciseInHistory(userId, "NoSplit", "Nothing")).toBe(0)
    const id = await w.createSession(userId, 4, "D", "2026-01-02T09:00:00Z", false, "RenSplit")
    await w.recordSetTiming(id, userId, set({ exerciseName: "Keep" }))
    expect(await w.renameExerciseInHistory(userId, "RenSplit", "Keep", undefined, ["back"])).toBe(1)
  })

  it("filters history by day number", async () => {
    await w.createSession(userId, 7, "Seven", "2026-01-03T09:00:00Z")
    const seven = await w.getSessionHistory(userId, null, 7)
    expect(seven.length).toBeGreaterThan(0)
    expect(seven.every((s) => s.dayNumber === 7)).toBe(true)
  })

  it("returns records past one IN list, ordering same-start workouts by id", async () => {
    const u = await internalId((await signup("wrec")).user.id)
    const a = await w.createSession(u, 1, "A", "2026-02-01T09:00:00Z")
    const b = await w.createSession(u, 2, "B", "2026-02-01T09:00:00Z")
    const c = await w.createSession(u, 3, "C", "2026-01-01T09:00:00Z")
    const [[ex]] = await pool.query<never[]>(`SELECT id FROM exercises WHERE name = 'EdgeRow'`)
    // One set per machine name, so each is its own record group: 5,001 kept
    // sets split over two workouts forces a second chunk.
    const bulk = (workout: number, from: number, n: number) =>
      pool.query(
        `INSERT INTO workout_sets (workout_id, exercise_id, set_index, start_time, end_time, weight, reps, machine_name)
         VALUES ?`,
        [Array.from({ length: n }, (_, i) => [workout, ex["id"], from + i, "2026-02-01 09:00:00", "2026-02-01 09:01:00", 10, 5, `m${from + i}`])],
      )
    await bulk(a, 0, 3000)
    await bulk(b, 3000, 2001)
    await pool.query(`INSERT INTO workout_sets (workout_id, exercise_id, set_index, start_time, end_time, weight, reps)
                      VALUES (?, ?, 0, '2026-01-01 09:00:00', '2026-01-01 09:01:00', 10, 5),
                             (?, ?, 1, '2026-01-01 09:02:00', '2026-01-01 09:03:00', 10, 6)`, [c, ex["id"], c, ex["id"]])

    const sessions = await w.getRecordSessions(u)
    expect(sessions.map((s) => s.id)).toEqual([b, a, c])
    expect(sessions.reduce((n, s) => n + s.setTimings.length, 0)).toBe(5003)
  }, 60_000)

  it("sweeps a full batch, then stops on the empty one", async () => {
    const u = await internalId((await signup("wstale")).user.id)
    await pool.query(`INSERT INTO workouts (user_id, day_number, start_time) VALUES ?`, [
      Array.from({ length: 500 }, () => [u, 1, "2026-01-01 00:00:00"]),
    ])
    // The sweep scans every stale workout in the shared test database, so a
    // parallel file changing its own can fail one pass (MariaDB 1020), and a
    // parallel sweep holding the lock makes this one a no-op. The job's next
    // tick retries in production, and so does this.
    await vi.waitFor(async () => {
      await w.endStaleSessions(30)
      const [[open]] = await pool.query<never[]>(`SELECT COUNT(*) AS n FROM workouts WHERE user_id = ? AND end_time IS NULL`, [u])
      expect(Number(open["n"])).toBe(0)
    }, { timeout: 30_000, interval: 200 })
  }, 60_000)

  it("rolls a failed sweep batch back", async () => {
    const conn = await pool.getConnection()
    const rollback = vi.spyOn(conn, "rollback")
    // Granted outright: a sweep from another file may hold the real lock.
    vi.spyOn(conn, "query").mockResolvedValueOnce([[{ got: 1 }]] as never)
    vi.spyOn(conn, "execute").mockRejectedValueOnce(new Error("sweep broke"))
    vi.spyOn(pool, "getConnection").mockResolvedValueOnce(conn as PoolConnection)
    await expect(w.endStaleSessions(30)).rejects.toThrow("sweep broke")
    expect(rollback).toHaveBeenCalled()
  })
})
