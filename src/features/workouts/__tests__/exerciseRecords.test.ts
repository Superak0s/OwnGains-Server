import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"
import { pickRecordSetIds, type RecordCandidate } from "../workouts.model.js"

describe("pickRecordSetIds", () => {
  let nextId = 1
  const set = (weight: number, reps: number, extra: Partial<RecordCandidate> = {}): RecordCandidate => ({
    id: nextId++,
    exerciseName: "Bench",
    machineName: null,
    weight,
    reps,
    ...extra,
  })

  it("keeps heaviest, lightest, most reps, best Epley and per-rep-count bests", () => {
    const heavy = set(120, 1)
    const light = set(40, 2)
    const manyReps = set(60, 25)
    const epleyBest = set(100, 10) // 133.3 beats heavy's 120
    const mid5a = set(80, 5)
    const mid5b = set(90, 5)
    const mid5c = set(85, 5) // neither heaviest nor lightest at 5 reps
    const kept = pickRecordSetIds([heavy, light, manyReps, epleyBest, mid5a, mid5b, mid5c])
    expect([...kept].sort((a, b) => a - b)).toEqual(
      [heavy.id, light.id, manyReps.id, epleyBest.id, mid5a.id, mid5b.id].sort((a, b) => a - b),
    )
    expect(kept.has(mid5c.id)).toBe(false)
  })

  it("keeps the earliest set on a tie", () => {
    const first = set(100, 3)
    const second = set(100, 3)
    const kept = pickRecordSetIds([first, second])
    expect(kept.has(first.id)).toBe(true)
    expect(kept.has(second.id)).toBe(false)
  })

  it("groups by exercise and machine, with a null machine its own group", () => {
    const free = set(100, 5)
    const machine = set(50, 5, { machineName: "Hammer" })
    const nullString = set(40, 5, { machineName: "null" })
    const kept = pickRecordSetIds([free, machine, nullString])
    expect(kept).toEqual(new Set([free.id, machine.id, nullString.id]))
  })

  it("ignores warm-ups, zero-rep sets and non-finite weights", () => {
    const real = set(60, 5)
    const kept = pickRecordSetIds([
      real,
      set(200, 5, { isWarmup: 1 }),
      set(200, 0),
      set(Number.NaN, 5),
    ])
    expect(kept).toEqual(new Set([real.id]))
  })

  it("has no per-rep-count record above 12 reps", () => {
    const thirteenA = set(50, 13)
    const thirteenB = set(55, 13)
    const kept = pickRecordSetIds([set(100, 1), thirteenA, thirteenB])
    // 13-rep sets only survive via the whole-group slots (lightest / most reps).
    expect(kept.has(thirteenA.id)).toBe(true) // lightest overall, and first to 13 reps
    expect(kept.has(thirteenB.id)).toBe(false)
  })
})

describe("GET /api/sessions/exercise-records", () => {
  let u: Awaited<ReturnType<typeof signup>>
  const sessions: number[] = []

  async function logSet(sessionId: number, exerciseName: string, setIndex: number, weight: number, reps: number, isWarmup = false) {
    const minute = String(setIndex).padStart(2, "0")
    await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(u.token))
      .send({
        exerciseName,
        setIndex,
        startTime: `2024-01-15T10:${minute}:00Z`,
        endTime: `2024-01-15T10:${minute}:30Z`,
        weight,
        reps,
        isWarmup,
      })
      .expect(200)
  }

  beforeAll(async () => {
    u = await signup("recs")
    // Recent start times: sessionCleanup.test.ts sweeps every open workout idle
    // >30 min across the shared DB, and would close old ones mid-setup (409).
    for (const minutesAgo of [3, 2, 1]) {
      const res = await request(app)
        .post("/api/sessions/start")
        .set(auth(u.token))
        .send({ dayNumber: 1, dayTitle: "Push", startTime: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
        .expect(200)
      sessions.push(res.body.session.id)
    }
    // Old session holds the heaviest set.
    await logSet(sessions[0], "Bench Press", 0, 100, 1)
    await logSet(sessions[0], "Bench Press", 1, 200, 1, true) // warm-up: never a record
    // Middle session has no new record: every set ties an earlier one.
    await logSet(sessions[1], "Bench Press", 0, 100, 1)
    // Latest session holds the rep record.
    await logSet(sessions[2], "Bench Press", 0, 50, 20)
    for (const id of sessions)
      await request(app).post(`/api/sessions/${id}/end`).set(auth(u.token)).expect(200)
  })

  it("returns only record-holding sessions, trimmed to their record sets", async () => {
    const res = await request(app).get("/api/sessions/exercise-records").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.sessions.map((s: { id: number }) => s.id)).toEqual([sessions[2], sessions[0]])

    const [latest, oldest] = res.body.sessions
    expect(oldest.setTimings).toHaveLength(1)
    expect(oldest.setTimings[0]).toMatchObject({ exerciseName: "Bench Press", weight: 100, reps: 1, machineName: null })
    expect(latest.setTimings).toHaveLength(1)
    expect(latest.setTimings[0]).toMatchObject({ weight: 50, reps: 20 })

    // Same session shape as the history route with timings.
    const history = await request(app).get("/api/sessions?includeTimings=true").set(auth(u.token))
    const histOldest = history.body.sessions.find((s: { id: number }) => s.id === sessions[0])
    expect(Object.keys(oldest).sort()).toEqual(Object.keys(histOldest).sort())
    expect(Object.keys(oldest.setTimings[0]).sort()).toEqual(Object.keys(histOldest.setTimings[0]).sort())
  })

  it("leaves demo workouts out", async () => {
    const d = await signup("recsd")
    const demo = await request(app)
      .post("/api/sessions/start")
      .set(auth(d.token))
      .send({ dayNumber: 1, dayTitle: "Demo", isDemo: true })
    expect(demo.status).toBe(200)
    await request(app)
      .post(`/api/sessions/${demo.body.session.id}/set`)
      .set(auth(d.token))
      .send({
        exerciseName: "Deadlift",
        setIndex: 1,
        startTime: "2024-01-15T10:00:00Z",
        endTime: "2024-01-15T10:00:30Z",
        weight: 200,
        reps: 5,
      })
      .expect(200)
    const res = await request(app).get("/api/sessions/exercise-records").set(auth(d.token))
    expect(res.body.sessions).toEqual([])
  })

  it("is [] with no history", async () => {
    const fresh = await signup("recs0")
    const res = await request(app).get("/api/sessions/exercise-records").set(auth(fresh.token))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, sessions: [] })
  })

  it("requires auth", async () => {
    expect((await request(app).get("/api/sessions/exercise-records")).status).toBe(401)
  })
})
