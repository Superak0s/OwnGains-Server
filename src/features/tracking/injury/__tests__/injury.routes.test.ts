import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("injury routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("injur")
  })

  it("logs injuries with validation", async () => {
    const missing = await request(app).post("/api/tracking/injuries").set(auth(u.token)).send({})
    expect(missing.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/injuries")
      .set(auth(u.token))
      .send({ muscleGroup: "shoulder", injuryType: "strain", painLevel: 3, note: "pinch" })
    expect(ok.status).toBe(201)
    expect(ok.body.data.id).toBeGreaterThan(0)
    expect(ok.body.data.note).toBe("pinch")
  })

  it("lists all, active, and per-muscle", async () => {
    const all = await request(app).get("/api/tracking/injuries").set(auth(u.token))
    expect(all.body.data.length).toBe(1)

    const active = await request(app).get("/api/tracking/injuries/active").set(auth(u.token))
    expect(active.body.data.length).toBe(1)

    const byMuscle = await request(app).get("/api/tracking/injuries/muscle/shoulder").set(auth(u.token))
    expect(byMuscle.body.data.length).toBe(1)

    const other = await request(app).get("/api/tracking/injuries/muscle/legs").set(auth(u.token))
    expect(other.body.data.length).toBe(0)
  })

  it("filters the list with ?muscle= and ?status=active", async () => {
    await request(app)
      .post("/api/tracking/injuries")
      .set(auth(u.token))
      .send({ muscleGroup: "knee", injuryType: "sprain", painLevel: 2 })

    const knee = await request(app).get("/api/tracking/injuries?muscle=knee").set(auth(u.token))
    expect(knee.body.data.map((i: { muscleGroup: string }) => i.muscleGroup)).toEqual(["knee"])

    const activeKnee = await request(app)
      .get("/api/tracking/injuries?muscle=knee&status=active")
      .set(auth(u.token))
    expect(activeKnee.body.data).toHaveLength(1)

    const bad = await request(app).get("/api/tracking/injuries?status=healed").set(auth(u.token))
    expect(bad.status).toBe(400)
  })

  it("updates an injury as it heals, then deletes it", async () => {
    const list = await request(app).get("/api/tracking/injuries?muscle=shoulder").set(auth(u.token))
    const id = list.body.data[0].id

    const badPain = await request(app)
      .patch(`/api/tracking/injuries/${id}`)
      .set(auth(u.token))
      .send({ painLevel: 11 })
    expect(badPain.status).toBe(400)

    const healed = await request(app)
      .patch(`/api/tracking/injuries/${id}`)
      .set(auth(u.token))
      .send({ status: "recovered", painLevel: 0 })
    expect(healed.status).toBe(200)
    expect(healed.body.data.status).toBe("recovered")

    const active = await request(app).get("/api/tracking/injuries/active").set(auth(u.token))
    expect(active.body.data.some((i: { id: number }) => i.id === id)).toBe(false)

    const other = await signup("injur2")
    const notYours = await request(app).delete(`/api/tracking/injuries/${id}`).set(auth(other.token))
    expect(notYours.status).toBe(404)

    const del = await request(app).delete(`/api/tracking/injuries/${id}`).set(auth(u.token))
    expect(del.status).toBe(200)
    const again = await request(app).delete(`/api/tracking/injuries/${id}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
