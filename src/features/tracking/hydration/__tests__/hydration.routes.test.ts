import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("hydration routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("hydr")
    const res = await request(app)
      .post("/api/tracking/hydration")
      .set(auth(u.token))
      .send({ amountMl: 500, note: "morning" })
    expect(res.status).toBe(201)
    entryId = res.body.data.id
  })

  it("lists entries", async () => {
    const history = await request(app).get("/api/tracking/hydration").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
    expect(history.body.data[0].value).toBe(500)
  })

  it("stores a per-entry errorMargin, 0 when missing, 400 when invalid", async () => {
    const ok = await request(app)
      .post("/api/tracking/hydration")
      .set(auth(u.token))
      .send({ amountMl: 250, errorMargin: 7.5, measuredAt: new Date(Date.now() - 1000).toISOString() })
    expect(ok.status).toBe(201)
    for (const errorMargin of [-1, 100.5, "5", true])
      expect(
        (await request(app).post("/api/tracking/hydration").set(auth(u.token)).send({ amountMl: 250, errorMargin })).status,
      ).toBe(400)
    const history = await request(app).get("/api/tracking/hydration").set(auth(u.token))
    const margins = Object.fromEntries(history.body.data.map((r: { id: number; errorMargin: number }) => [r.id, r.errorMargin]))
    expect(margins[ok.body.data.id]).toBe(7.5)
    expect(margins[entryId]).toBe(0)
    await request(app).delete(`/api/tracking/hydration/${ok.body.data.id}`).set(auth(u.token))
  })

  // The hydration goal is stored in /api/settings with every other preference now.
  it("updates hydration settings with validation", async () => {
    const bad = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: -5 })
    expect(bad.status).toBe(400)

    const zero = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: 0 })
    expect(zero.status).toBe(400)

    const ok = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: 2500, hydrationErrorPercent: 5 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.hydrationGoalMl).toBe(2500)

    const read = await request(app).get("/api/settings").set(auth(u.token))
    expect(read.body.data.hydrationGoalMl).toBe(2500)
  })

  it("deletes entries, 404 on a missing one", async () => {
    const del = await request(app).delete(`/api/tracking/hydration/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/hydration/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)

    const badId = await request(app).delete("/api/tracking/hydration/abc").set(auth(u.token))
    expect(badId.status).toBe(400)
  })

  it("keeps two drinks logged at the same instant, and dedupes a keyed replay", async () => {
    const drinker = await signup("hydr2")
    const at = "2026-01-05T09:00:00.000Z"
    const log = (amountMl: number, key?: string) => {
      const r = request(app).post("/api/tracking/hydration").set(auth(drinker.token))
      if (key) r.set("Idempotency-Key", key)
      return r.send({ amountMl, measuredAt: at })
    }
    const a = await log(250)
    const b = await log(250)
    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.body.data.id).not.toBe(b.body.data.id)

    const first = await log(330, "drink-1")
    const replay = await log(330, "drink-1")
    expect(replay.status).toBe(201)
    expect(replay.body.data.id).toBe(first.body.data.id)

    const history = await request(app).get("/api/tracking/hydration").set(auth(drinker.token))
    expect(history.body.data.map((e: { value: number }) => e.value).sort()).toEqual([250, 250, 330])

    // Deleting one drink leaves its twin.
    await request(app).delete(`/api/tracking/hydration/${a.body.data.id}`).set(auth(drinker.token)).expect(200)
    const after = await request(app).get("/api/tracking/hydration").set(auth(drinker.token))
    expect(after.body.data.length).toBe(2)
  })
})
