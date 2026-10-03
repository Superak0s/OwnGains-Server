import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import type { RowDataPacket } from "mysql2"
import { pool } from "../../../config/database.js"
import { app, signup, auth, uniqueName } from "../../../tests/helpers.js"
import { findOrCreateExercise } from "../workouts.model.js"

async function catalogNames(ids: number[]): Promise<Map<number, string>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name FROM exercises WHERE id IN (?)`,
    [ids],
  )
  return new Map(rows.map((r) => [r.id as number, r.name as string]))
}

describe("exercise catalog", () => {
  // The old helper ran the INSERT and `SELECT LAST_INSERT_ID()` as two pool
  // calls. Under concurrency the SELECT ran on another connection and
  // returned that connection's id, so sets attached to someone else's exercise.
  it("returns each name's own id when many first inserts race", async () => {
    const names = Array.from({ length: 40 }, () => uniqueName("race"))
    const ids = await Promise.all(names.map((n) => findOrCreateExercise(null, n)))

    const stored = await catalogNames(ids)
    names.forEach((name, i) => expect(stored.get(ids[i])).toBe(name))
  })

  it("gives every racer the same id for one new name", async () => {
    const name = uniqueName("same")
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => findOrCreateExercise(null, name, ["chest"])),
    )
    expect(new Set(ids).size).toBe(1)
    expect((await catalogNames(ids)).get(ids[0])).toBe(name)
  })

  describe("over HTTP", () => {
    let owner: Awaited<ReturnType<typeof signup>>
    let stranger: Awaited<ReturnType<typeof signup>>
    let sessionId: number

    beforeAll(async () => {
      owner = await signup("cato")
      stranger = await signup("cats")
      const start = await request(app)
        .post("/api/sessions/start")
        .set(auth(owner.token))
        .send({ dayNumber: 1, dayTitle: "Catalog" })
      sessionId = start.body.session.id
    })

    it("writes no catalog row for a set posted to someone else's workout", async () => {
      const name = uniqueName("foreign")
      const res = await request(app)
        .post(`/api/sessions/${sessionId}/set`)
        .set(auth(stranger.token))
        .send({
          exerciseName: name,
          setIndex: 0,
          startTime: "2024-01-15T10:00:00Z",
          endTime: "2024-01-15T10:00:30Z",
        })
      expect(res.status).toBe(403)
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT id FROM exercises WHERE name = ?`,
        [name],
      )
      expect(rows).toHaveLength(0)
    })

    it("attaches concurrently logged first-sighting sets to their own names", async () => {
      const names = Array.from({ length: 10 }, () => uniqueName("par"))
      const results = await Promise.all(
        names.map((exerciseName, setIndex) =>
          request(app)
            .post(`/api/sessions/${sessionId}/set`)
            .set(auth(owner.token))
            .send({
              exerciseName,
              setIndex,
              startTime: "2024-01-15T10:00:00Z",
              endTime: "2024-01-15T10:00:30Z",
            }),
        ),
      )
      results.forEach((r) => expect(r.status).toBe(200))
      const stored = await catalogNames(results.map((r) => r.body.timing.exerciseId))
      results.forEach((r, i) =>
        expect(stored.get(r.body.timing.exerciseId)).toBe(names[i]),
      )
    })

    it("rejects over-long or non-string muscle arrays", async () => {
      const base = {
        exerciseName: uniqueName("mus"),
        setIndex: 0,
        startTime: "2024-01-15T10:00:00Z",
        endTime: "2024-01-15T10:00:30Z",
      }
      const tooMany = await request(app)
        .post(`/api/sessions/${sessionId}/set`)
        .set(auth(owner.token))
        .send({ ...base, primaryMuscles: Array.from({ length: 50 }, (_, i) => `m${i}`) })
      expect(tooMany.status).toBe(400)
      const scalar = await request(app)
        .post(`/api/sessions/${sessionId}/set`)
        .set(auth(owner.token))
        .send({ ...base, secondaryMuscles: "chest" })
      expect(scalar.status).toBe(400)
    })
  })
})

describe("per-user muscle labels", () => {
  // The catalog is shared by name, and its muscle columns used to be too:
  // whoever labelled an exercise first chose what everyone saw.
  it("shows each user their own labels, falling back to the catalog's", async () => {
    const name = uniqueName("lbl")
    const first = await signup("lbla")
    const second = await signup("lblb")
    const unlabelled = await signup("lblc")

    async function logOne(u: Awaited<ReturnType<typeof signup>>, muscles?: string[]) {
      const start = await request(app)
        .post("/api/sessions/start")
        .set(auth(u.token))
        .send({ dayNumber: 1, dayTitle: "Labels" })
      const id = start.body.session.id
      await request(app)
        .post(`/api/sessions/${id}/set`)
        .set(auth(u.token))
        .send({
          exerciseName: name,
          setIndex: 0,
          startTime: "2024-03-01T10:00:00Z",
          endTime: "2024-03-01T10:00:30Z",
          weight: 20,
          reps: 10,
          ...(muscles && { primaryMuscles: muscles }),
        })
        .expect(200)
      const detail = await request(app).get(`/api/sessions/${id}`).set(auth(u.token))
      return detail.body.session.setTimings[0].exercisePrimaryMuscles
    }

    expect(await logOne(first, ["calves"])).toEqual(["calves"])
    // The second user's own labels win for them, and don't touch the first's.
    expect(await logOne(second, ["chest"])).toEqual(["chest"])
    // Someone who never labelled it sees the catalog's (first-come) labels.
    expect(await logOne(unlabelled)).toEqual(["calves"])

    const history = await request(app).get("/api/sessions?includeTimings=true").set(auth(first.token))
    expect(history.body.sessions[0].setTimings[0].exercisePrimaryMuscles).toEqual(["calves"])

    // A relabel replaces the user's own labels.
    expect(await logOne(second, ["pecs"])).toEqual(["pecs"])
  })
})
