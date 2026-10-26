import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("soreness routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("sore")
    const res = await request(app)
      .post("/api/tracking/soreness")
      .set(auth(u.token))
      .send({ muscleGroup: "chest", intensity: 6, note: "after bench" })
    expect(res.status).toBe(201)
    entryId = res.body.data.id
  })

  it("lists entries", async () => {
    const history = await request(app).get("/api/tracking/soreness").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
    expect(history.body.data[0].muscleGroup).toBe("chest")
    expect(history.body.data[0].followUps).toEqual([])

    const active = await request(app).get("/api/tracking/soreness?status=active").set(auth(u.token))
    expect(active.body.data.length).toBe(1)
  })

  it("records follow-ups", async () => {
    const one = await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(u.token))
      .send({ updates: [{ sorenessId: entryId, intensity: 3, status: "better" }] })
    expect(one.status).toBe(200)

    const batch = await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(u.token))
      .send({ updates: [{ sorenessId: entryId, intensity: 0, status: "recovered" }] })
    expect(batch.status).toBe(200)

    const bad = await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(u.token))
      .send({ updates: [{ sorenessId: entryId, intensity: 11, status: "better" }] })
    expect(bad.status).toBe(400)

    const history = await request(app).get("/api/tracking/soreness").set(auth(u.token))
    expect(history.body.data[0].followUps.length).toBe(2)
    expect(history.body.data[0].status).toBe("recovered")
    expect(history.body.data[0].recoveredAt).toBeTruthy()
  })

  it("deletes entries", async () => {
    const del = await request(app).delete(`/api/tracking/soreness/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/soreness/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })

  it("computes stats from two queries with the same numbers as before", async () => {
    const s = await signup("sorestat")
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    const log = (muscleGroup: string, intensity: number, loggedAt: string) =>
      request(app)
        .post("/api/tracking/soreness")
        .set(auth(s.token))
        .send({ muscleGroup, intensity, loggedAt })
        .expect(201)
    const a = await log("chest", 8, day(2))
    await log("chest", 4, day(2))
    await log("legs", 5, day(1))
    await log("back", 3, day(60)) // outside the 30-day window

    // Recover one. The rest remain active.
    await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(s.token))
      .send({ updates: [{ sorenessId: a.body.data.id, intensity: 0, status: "recovered" }] })
      .expect(200)

    const res = await request(app).get("/api/tracking/soreness/stats").set(auth(s.token))
    expect(res.status).toBe(200)
    const st = res.body.data
    expect(st.totalActiveSoreness).toBe(3)
    expect(st.totalRecoveryEpisodes).toBe(1)
    expect(st.averageRecoveryDays).toBe(2)
    expect(st.mostSoreMuscle).toBe("legs")
    expect(st.heatmapData).toEqual({ chest: 2, legs: 1 })
    // chest day: (0 after recovery + 4) / 2. Legs day: 5
    expect(st.severityTrend.map((t: { averageIntensity: number }) => t.averageIntensity)).toEqual([2, 5])

    const empty = await signup("sorestat0")
    const none = await request(app).get("/api/tracking/soreness/stats").set(auth(empty.token))
    expect(none.body.data).toEqual({
      totalActiveSoreness: 0,
      totalRecoveryEpisodes: 0,
      averageRecoveryDays: 0,
      mostSoreMuscle: null,
      heatmapData: {},
      severityTrend: [],
    })
  })

  it("buckets the trend by the client's local day", async () => {
    const s = await signup("soretz")
    const at = new Date(Date.now() - 86_400_000)
    // 22:30 UTC is already the next day in Athens.
    at.setUTCHours(22, 30, 0, 0)
    await request(app)
      .post("/api/tracking/soreness")
      .set({ ...auth(s.token), "X-Time-Zone": "Europe/Athens" })
      .send({ muscleGroup: "chest", intensity: 5, loggedAt: at.toISOString() })
      .expect(201)

    const res = await request(app)
      .get("/api/tracking/soreness/stats")
      .set({ ...auth(s.token), "X-Time-Zone": "Europe/Athens" })
    expect(res.body.data.severityTrend[0].date).toBe(
      new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10),
    )
  })

  it("keeps the trend in date order when zones disagree", async () => {
    const s = await signup("soreorder")
    const log = (timeZone: string, at: Date) =>
      request(app)
        .post("/api/tracking/soreness")
        .set({ ...auth(s.token), "X-Time-Zone": timeZone })
        .send({ muscleGroup: "chest", intensity: 5, loggedAt: at.toISOString() })
        .expect(201)
    const athens = new Date(Date.now() - 86_400_000)
    athens.setUTCHours(22, 30, 0, 0)
    await log("Europe/Athens", athens)
    await log("America/Los_Angeles", new Date(athens.getTime() + 30 * 60_000))

    const res = await request(app).get("/api/tracking/soreness/stats").set(auth(s.token))
    const dates = res.body.data.severityTrend.map((d: { date: string }) => d.date)
    expect(dates).toEqual([...dates].sort())
    expect(dates).toHaveLength(2)
  })

  it("returns the latest 20 follow-ups per episode and batches in one UPDATE", async () => {
    const f = await signup("sorefu")
    const ep = await request(app)
      .post("/api/tracking/soreness")
      .set(auth(f.token))
      .send({ muscleGroup: "chest", intensity: 9, note: "keep me" })
    const id = ep.body.data.id
    const updates = Array.from({ length: 25 }, (_, i) => ({
      sorenessId: id,
      intensity: i % 11,
      status: "still_sore",
    }))
    const batch = await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(f.token))
      .send({ updates })
    expect(batch.status).toBe(200)
    const entry = batch.body.data[0]
    // The later item for the same episode is applied, and an absent note leaves it alone.
    expect(entry.intensity).toBe(24 % 11)
    expect(entry.note).toBe("keep me")
    expect(entry.followUps).toHaveLength(20)
    expect(entry.followUps.at(-1).id).toBeGreaterThan(entry.followUps[0].id)

    const cleared = await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(f.token))
      .send({ updates: [{ sorenessId: id, intensity: 1, status: "better", note: null }] })
    expect(cleared.body.data[0]).toMatchObject({ note: null, status: "recovering" })

    const longNote = await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(f.token))
      .send({ updates: [{ sorenessId: id, intensity: 1, status: "better", note: "x".repeat(1001) }] })
    expect(longNote.status).toBe(400)
  })

  it("lists by ?muscle=", async () => {
    const s2 = await signup("sormu")
    for (const muscleGroup of ["quads", "quads", "calves"])
      await request(app)
        .post("/api/tracking/soreness")
        .set(auth(s2.token))
        .send({ muscleGroup, intensity: 4 })

    const byQuery = await request(app).get("/api/tracking/soreness?muscle=calves").set(auth(s2.token))
    expect(byQuery.body.data.map((e: { muscleGroup: string }) => e.muscleGroup)).toEqual(["calves"])

    const activeQuads = await request(app)
      .get("/api/tracking/soreness?muscle=quads&status=active")
      .set(auth(s2.token))
    expect(activeQuads.body.data).toHaveLength(2)
  })
})
