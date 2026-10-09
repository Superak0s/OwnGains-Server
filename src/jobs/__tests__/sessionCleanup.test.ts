import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { pool } from "../../config/database.js"
import { createUser } from "../../features/auth/auth.model.js"
import { uniqueName } from "../../tests/helpers.js"
import { endStaleSessions } from "../../features/workouts/workouts.model.js"
import {
  startStaleSessionCleanup,
  stopStaleSessionCleanup,
  runStaleSessionCleanup,
} from "../sessionCleanup.js"

// Only workouts idle for 30+ minutes are touched, so the fresh workouts other
// test files create are safe from this job running against the shared scratch DB.
describe("sessionCleanup", () => {
  let staleId: number
  let freshId: number

  async function openSession(startsMinutesAgo: number): Promise<number> {
    const username = uniqueName("clean")
    const userId = await createUser(
      username,
      `${username}@test.local`,
      "Passw0rd-123",
    )
    const [res] = await pool.execute(
      `INSERT INTO workouts (user_id, day_number, day_title, start_time)
       VALUES (?, 1, 'Cleanup day', NOW() - INTERVAL ? MINUTE)`,
      [userId, startsMinutesAgo],
    )
    return (res as { insertId: number }).insertId
  }

  beforeAll(async () => {
    staleId = await openSession(45)
    freshId = await openSession(1)

    // A set whose end_time is BEFORE its workout's start_time: a device with
    // a slow clock, or an offline set replayed later. The sweep is one
    // UPDATE, so one such row used to make it violate ck_w_times and end
    // nothing at all, for every user, on every 5-minute tick, forever.
    const [ex] = await pool.execute(
      `INSERT INTO exercises (name) VALUES (?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [uniqueName("clockskew")],
    )
    await pool.execute(
      `INSERT INTO workout_sets
         (workout_id, exercise_id, set_index, start_time, end_time, set_duration)
       VALUES (?, ?, 0, NOW() - INTERVAL 90 MINUTE, NOW() - INTERVAL 90 MINUTE, 0)`,
      [staleId, (ex as { insertId: number }).insertId],
    )
  })

  afterAll(async () => {
    stopStaleSessionCleanup()
    await pool.execute("DELETE FROM workouts WHERE id IN (?, ?)", [
      staleId,
      freshId,
    ])
  })

  it("ends workouts idle for 30+ minutes and leaves fresh ones alone", async () => {
    startStaleSessionCleanup() // runs once immediately, then every 5 min
    startStaleSessionCleanup() // idempotent, no second interval

    // The rest of the suite writes to `workouts` concurrently against the
    // shared scratch DB, and a sweep that collides with one of those writes
    // fails and waits 5 minutes for its next tick. Drive the sweep directly
    // and retry, rather than racing the scheduler's single immediate run.
    let stale: { end_time: string | null; total_duration: number } | undefined
    for (let attempt = 0; attempt < 10; attempt++) {
      await runStaleSessionCleanup()
      const [rows] = await pool.query(
        "SELECT end_time, total_duration FROM workouts WHERE id = ?",
        [staleId],
      )
      stale = (rows as typeof stale[])[0]
      if (stale?.end_time) break
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(stale!.end_time).toBeTruthy()
    expect(stale!.total_duration).toBe(0)

    const [fresh] = await pool.query(
      "SELECT end_time FROM workouts WHERE id = ?",
      [freshId],
    )
    expect((fresh as { end_time: string | null }[])[0].end_time).toBeNull()
  })
})

describe("endStaleSessions", () => {
  async function staleWorkout(): Promise<number> {
    const username = uniqueName("sweep")
    const userId = await createUser(username, `${username}@test.local`, "Passw0rd-123")
    const [res] = await pool.execute(
      `INSERT INTO workouts (user_id, day_number, day_title, start_time)
       VALUES (?, 1, 'Sweep day', NOW() - INTERVAL 50 MINUTE)`,
      [userId],
    )
    return (res as { insertId: number }).insertId
  }

  it("stands down while another sweep holds the lock", async () => {
    const endTime = async () => {
      const [rows] = await pool.query("SELECT end_time FROM workouts WHERE id = ?", [id])
      return (rows as { end_time: string | null }[])[0].end_time
    }
    // Other files boot real sweeps against this database, so the workout is
    // only created once the lock is held: no sweep can end it before then.
    const holder = await pool.getConnection()
    let id: number
    try {
      const [[{ got }]] = (await holder.query(`SELECT GET_LOCK('owngains_session_cleanup', 30) AS got`)) as unknown as [[{ got: number }]]
      expect(got).toBe(1)
      id = await staleWorkout()
      expect(await endStaleSessions(30)).toEqual([])
      expect(await endTime()).toBeNull()
    } finally {
      await holder.query(`SELECT RELEASE_LOCK('owngains_session_cleanup')`)
      holder.release()
    }

    // Retry: another sweep may hold the lock for a moment, and may be the one
    // that ends this workout, so check the row rather than what this call returns.
    for (let i = 0; i < 10 && !(await endTime()); i++) {
      await endStaleSessions(30).catch(() => [])
      if (!(await endTime())) await new Promise((r) => setTimeout(r, 200))
    }
    expect(await endTime()).not.toBeNull()
    await pool.execute("DELETE FROM workouts WHERE id = ?", [id])
  })

  it("reports each ended workout at most once when sweeps overlap", async () => {
    const ids = [await staleWorkout(), await staleWorkout()]
    const runs = await Promise.all([endStaleSessions(30), endStaleSessions(30)])
    const reported = runs.flat().filter((e) => ids.includes(e.id)).map((e) => e.id)
    expect(new Set(reported).size).toBe(reported.length)
    await pool.execute("DELETE FROM workouts WHERE id IN (?, ?)", ids)
  })
})
