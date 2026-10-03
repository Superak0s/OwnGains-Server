import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("menstrual routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("mens")
    const missing = await request(app).post("/api/tracking/menstrual").set(auth(u.token)).send({})
    expect(missing.status).toBe(400)

    const res = await request(app)
      .post("/api/tracking/menstrual")
      .set(auth(u.token))
      .send({ cycleStart: "2024-05-01", symptoms: ["cramps"] })
    expect(res.status).toBe(201)
    expect(res.body.data.symptoms).toEqual(["cramps"])
    entryId = res.body.data.id
  })

  it("lists history and stats", async () => {
    const history = await request(app).get("/api/tracking/menstrual").set(auth(u.token))
    expect(history.body.data.length).toBeGreaterThanOrEqual(1)

    const stats = await request(app).get("/api/tracking/menstrual/stats").set(auth(u.token))
    expect(stats.status).toBe(200)
  })

  // The app's menstrual tab previews stats under lengths the user is editing
  // before it saves them to /api/settings.
  it("previews stats under overridden cycle lengths", async () => {
    const overridden = await request(app)
      .get("/api/tracking/menstrual/stats?periodDays=7&cycleLengthDays=40")
      .set(auth(u.token))
    expect(overridden.status).toBe(200)
    // Only one entry, so there is no observed average to outrank the override.
    expect(overridden.body.data.averageCycleLength).toBe(40)

    const bad = await request(app)
      .get("/api/tracking/menstrual/stats?cycleLengthDays=0")
      .set(auth(u.token))
    expect(bad.status).toBe(400)
  })

  it("closes a cycle with PATCH", async () => {
    const patched = await request(app)
      .patch(`/api/tracking/menstrual/${entryId}`)
      .set(auth(u.token))
      .send({ cycleEnd: "2024-05-05", symptoms: ["cramps", "fatigue"] })
    expect(patched.status).toBe(200)
    expect(patched.body.data.cycleEnd).toContain("2024-05-05")
    expect(patched.body.data.symptoms).toEqual(["cramps", "fatigue"])
  })

  // Period and cycle length are /api/settings keys now, not a menstrual route.
  it("updates cycle settings with validation", async () => {
    const bad = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ cyclePeriodDays: 0 })
    expect(bad.status).toBe(400)

    const tooLong = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ cyclePeriodDays: 40, cycleLengthDays: 28 })
    expect(tooLong.status).toBe(400)

    const ok = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ cyclePeriodDays: 5, cycleLengthDays: 28 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.cyclePeriodDays).toBe(5)
  })

  it("deletes entries", async () => {
    const del = await request(app).delete(`/api/tracking/menstrual/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/menstrual/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })

  it("bounds the symptom list at 30 entries of 64 characters", async () => {
    const post = (symptoms: unknown) =>
      request(app).post("/api/tracking/menstrual").set(auth(u.token)).send({ cycleStart: "2024-06-01", symptoms })
    expect((await post(Array(31).fill("cramps"))).status).toBe(400)
    expect((await post(["x".repeat(65)])).status).toBe(400)
    expect((await post(Array(30).fill("x".repeat(64)))).status).toBe(201)
  })
})
