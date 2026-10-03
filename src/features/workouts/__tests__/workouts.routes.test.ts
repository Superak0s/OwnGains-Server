import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("workout session routes", () => {
  let a: Awaited<ReturnType<typeof signup>>
  let b: Awaited<ReturnType<typeof signup>>
  let sessionId: number

  beforeAll(async () => {
    a = await signup("woa")
    b = await signup("wob")
  })

  it("lists sessions (empty) and rejects bad starts", async () => {
    const empty = await request(app).get("/api/sessions").set(auth(a.token))
    expect(empty.status).toBe(200)
    expect(empty.body.sessions).toHaveLength(0)

    const bad = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 0, dayTitle: "" })
    expect(bad.status).toBe(400)
  })

  it("starts a session and records sets", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 1, dayTitle: "Push Day", split: "push", primaryMuscles: ["chest"] })
    expect(start.status).toBe(200)
    sessionId = start.body.session.id
    expect(sessionId).toBeGreaterThan(0)

    const badSet = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(a.token))
      .send({ exerciseName: "Bench Press", setIndex: 0 })
    expect(badSet.status).toBe(400)

    const set1 = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(a.token))
      .send({
        exerciseName: "Bench Press",
        setIndex: 0,
        startTime: "2024-01-15T10:00:00Z",
        endTime: "2024-01-15T10:00:40Z",
        weight: 80,
        reps: 8,
        rir: 2,
        primaryMuscles: ["chest"],
      })
    expect(set1.status).toBe(200)
    expect(set1.body.timing.rir).toBe(2)

    const badRir = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(a.token))
      .send({
        exerciseName: "Bench Press",
        setIndex: 0,
        startTime: "2024-01-15T10:00:00Z",
        endTime: "2024-01-15T10:00:40Z",
        rir: 10,
      })
    expect(badRir.status).toBe(400)

    const set2 = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(a.token))
      .send({
        exerciseName: "Bench Press",
        setIndex: 1,
        startTime: "2024-01-15T10:02:00Z",
        endTime: "2024-01-15T10:02:45Z",
        weight: 82.5,
        reps: 8,
      })
    expect(set2.status).toBe(200)
    expect(set2.body.timing.restTime).toBeGreaterThan(0)
    // Unrated remains unrated, never coerced to 0.
    expect(set2.body.timing.rir).toBeNull()

    const patch = await request(app)
      .patch(`/api/sessions/${sessionId}/sets/${set1.body.timing.id}`)
      .set(auth(a.token))
      .send({ weight: 90, reps: 7 })
    expect(patch.status).toBe(200)
    // rir omitted from the patch body: the stored rating is left untouched.
    expect(patch.body.timing.rir).toBe(2)

    const failureSet = await request(app)
      .patch(`/api/sessions/${sessionId}/sets/${set2.body.timing.id}`)
      .set(auth(a.token))
      .send({ rir: 0 })
    // 0 is a real rating (failure), not unrated.
    expect(failureSet.body.timing.rir).toBe(0)

    const details = await request(app)
      .get(`/api/sessions/${sessionId}`)
      .set(auth(a.token))
    expect(details.status).toBe(200)
    expect(details.body.session.setTimings.length).toBe(2)
    expect(details.body.session.setTimings.map((t: { rir: number | null }) => t.rir).sort()).toEqual([0, 2])
  })

  it("keeps other users out of a session", async () => {
    const foreign = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(b.token))
      .send({
        exerciseName: "Squat",
        setIndex: 0,
        startTime: "2024-01-15T10:00:00Z",
        endTime: "2024-01-15T10:01:00Z",
      })
    expect(foreign.status).toBe(403)
    expect(foreign.body.code).toBe("SESSION_NOT_FOUND")

    const badId = await request(app).get("/api/sessions/abc").set(auth(a.token))
    expect(badId.status).toBe(400)
  })

  it("renames exercises across a split's history", async () => {
    const bad = await request(app)
      .post("/api/sessions/rename-exercise")
      .set(auth(a.token))
      .send({ oldName: "Bench Press" })
    expect(bad.status).toBe(400)

    const ok = await request(app)
      .post("/api/sessions/rename-exercise")
      .set(auth(a.token))
      .send({ split: "push", oldName: "Bench Press", newName: "Bench" })
    expect(ok.status).toBe(200)
    expect(ok.body.updatedCount).toBeGreaterThanOrEqual(2)
  })

  it("ends a session and computes its duration", async () => {
    const end = await request(app)
      .post(`/api/sessions/${sessionId}/end`)
      .set(auth(a.token))
      .send({})
    expect(end.status).toBe(200)
    expect(end.body.session.endTime).toBeTruthy()

    const history = await request(app).get("/api/sessions").set(auth(a.token))
    expect(history.body.sessions).toHaveLength(1)
  })

  it("deletes demo and per-split history", async () => {
    const demo = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 2, dayTitle: "Demo Day", split: "pull", isDemo: true })
    expect(demo.status).toBe(200)

    const clearDemo = await request(app).delete("/api/sessions/demo").set(auth(a.token))
    expect(clearDemo.status).toBe(200)
    expect(clearDemo.body.deletedCount).toBe(1)

    const clearSplit = await request(app)
      .delete("/api/sessions/split/push")
      .set(auth(a.token))
    expect(clearSplit.status).toBe(200)
    expect(clearSplit.body.deletedCount).toBeGreaterThanOrEqual(1)

    const nothing = await request(app)
      .delete("/api/sessions/split/nonexistent")
      .set(auth(a.token))
    expect(nothing.status).toBe(200)
    expect(nothing.body.deletedCount).toBe(0)
  })

  it("rejects a non-boolean isDemo", async () => {
    const bad = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 1, dayTitle: "Day", isDemo: "yes" })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain("isDemo")
  })

  it("deletes a recorded set by exercise name and index", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 3, dayTitle: "Leg Day", split: "legs" })
    const legsId = start.body.session.id

    const recordSet = (setIndex: number) =>
      request(app)
        .post(`/api/sessions/${legsId}/set`)
        .set(auth(a.token))
        .send({
          exerciseName: "Squat",
          setIndex,
          startTime: "2024-01-16T10:00:00Z",
          endTime: "2024-01-16T10:00:40Z",
          weight: 100,
          reps: 5,
        })
    await recordSet(0)
    await recordSet(1)

    const del = await request(app)
      .delete(`/api/sessions/${legsId}/sets`)
      .query({ exerciseName: "Squat", setIndex: 1 })
      .set(auth(a.token))
    expect(del.status).toBe(200)
    expect(del.body.deletedCount).toBe(1)

    const details = await request(app)
      .get(`/api/sessions/${legsId}`)
      .set(auth(a.token))
    expect(details.body.session.setTimings).toHaveLength(1)
    expect(details.body.session.setTimings[0].setIndex).toBe(0)

    // The stored counter history reads from must track the deletion, not just
    // the rows.
    const history = await request(app)
      .get("/api/sessions?split=legs")
      .set(auth(a.token))
    expect(history.body.sessions[0].setCount).toBe(1)

    // Deleting what is already gone is a no-op, so a retried sync is safe.
    const again = await request(app)
      .delete(`/api/sessions/${legsId}/sets`)
      .query({ exerciseName: "Squat", setIndex: 1 })
      .set(auth(a.token))
    expect(again.status).toBe(200)
    expect(again.body.deletedCount).toBe(0)

    // Left open, the stale-session sweep would try to close it at its newest
    // set's 2024 timestamp and trip the end_time >= start_time constraint.
    await request(app).post(`/api/sessions/${legsId}/end`).set(auth(a.token)).send({})
  })

  it("validates and scopes set deletion", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 4, dayTitle: "Arms", split: "arms" })
    const armsId = start.body.session.id

    const noName = await request(app)
      .delete(`/api/sessions/${armsId}/sets`)
      .query({ setIndex: 0 })
      .set(auth(a.token))
    expect(noName.status).toBe(400)

    const badIndex = await request(app)
      .delete(`/api/sessions/${armsId}/sets`)
      .query({ exerciseName: "Curl", setIndex: "x" })
      .set(auth(a.token))
    expect(badIndex.status).toBe(400)

    // 0 is a real set index, not a missing one.
    const zero = await request(app)
      .delete(`/api/sessions/${armsId}/sets`)
      .query({ exerciseName: "Curl", setIndex: 0 })
      .set(auth(a.token))
    expect(zero.status).toBe(200)

    const foreign = await request(app)
      .delete(`/api/sessions/${armsId}/sets`)
      .query({ exerciseName: "Curl", setIndex: 0 })
      .set(auth(b.token))
    expect(foreign.status).toBe(404)

    await request(app).post(`/api/sessions/${armsId}/end`).set(auth(a.token)).send({})
  })

  it("replays an Idempotency-Key instead of writing twice", async () => {
    const key = `${Date.now()}-abcd1234`
    const body = { dayNumber: 3, dayTitle: "Legs", split: "idem" }
    const first = await request(app)
      .post("/api/sessions/start").set(auth(a.token)).set("Idempotency-Key", key).send(body)
    expect(first.status).toBe(200)
    const replay = await request(app)
      .post("/api/sessions/start").set(auth(a.token)).set("Idempotency-Key", key).send(body)
    expect(replay.status).toBe(200)
    expect(replay.text).toBe(first.text)
    const list = await request(app).get("/api/sessions?split=idem").set(auth(a.token))
    expect(list.body.sessions).toHaveLength(1)

    // Same key with a different body, or another user's (separate) key space.
    const reused = await request(app)
      .post("/api/sessions/start").set(auth(a.token)).set("Idempotency-Key", key)
      .send({ ...body, dayNumber: 4 })
    expect(reused.status).toBe(422)
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED")
    const otherUser = await request(app)
      .post("/api/sessions/start").set(auth(b.token)).set("Idempotency-Key", key).send(body)
    expect(otherUser.status).toBe(200)

    const tooLong = await request(app)
      .post("/api/sessions/start").set(auth(a.token)).set("Idempotency-Key", "x".repeat(65)).send(body)
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe("Idempotency-Key must be 1-64 characters")

    // A failed write doesn't burn the key.
    const failKey = `${Date.now()}-fail0000`
    const bad = await request(app)
      .post("/api/sessions/start").set(auth(a.token)).set("Idempotency-Key", failKey).send({ dayNumber: 0 })
    expect(bad.status).toBe(400)
    const retry = await request(app)
      .post("/api/sessions/start").set(auth(a.token)).set("Idempotency-Key", failKey).send(body)
    expect(retry.status).toBe(200)

    for (const [id, tok] of [[first.body.session.id, a.token], [retry.body.session.id, a.token], [otherUser.body.session.id, b.token]])
      await request(app).post(`/api/sessions/${id}/end`).set(auth(tok)).send({})
  })

  // rest_time is computed on insert. Editing a time or deleting a set used to
  // leave the neighbouring set's rest stale.
  it("keeps rest times right after a set is edited or deleted", async () => {
    const r = await signup("rest")
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(r.token))
      .send({ dayNumber: 1, dayTitle: "Rest" })
    const id = start.body.session.id
    const log = async (setIndex: number, from: string, to: string) =>
      (
        await request(app)
          .post(`/api/sessions/${id}/set`)
          .set(auth(r.token))
          .send({ exerciseName: "Row", setIndex, startTime: from, endTime: to, weight: 50, reps: 10 })
          .expect(200)
      ).body.timing.id
    const s1 = await log(0, "2024-02-01T10:00:00Z", "2024-02-01T10:00:30Z")
    const s2 = await log(1, "2024-02-01T10:02:00Z", "2024-02-01T10:02:30Z")
    const s3 = await log(2, "2024-02-01T10:04:00Z", "2024-02-01T10:04:30Z")
    const rests = async () => {
      const d = await request(app).get(`/api/sessions/${id}`).set(auth(r.token))
      return Object.fromEntries(d.body.session.setTimings.map((t: any) => [t.id, t.restTime]))
    }
    expect(await rests()).toEqual({ [s1]: null, [s2]: 90, [s3]: 90 })

    await request(app)
      .patch(`/api/sessions/${id}/sets/${s2}`)
      .set(auth(r.token))
      .send({ endTime: "2024-02-01T10:03:00Z" })
      .expect(200)
    expect(await rests()).toEqual({ [s1]: null, [s2]: 90, [s3]: 60 })

    await request(app)
      .delete(`/api/sessions/${id}/sets`)
      .query({ exerciseName: "Row", setIndex: 1 })
      .set(auth(r.token))
      .expect(200)
    expect(await rests()).toEqual({ [s1]: null, [s3]: 210 })
  })
})
