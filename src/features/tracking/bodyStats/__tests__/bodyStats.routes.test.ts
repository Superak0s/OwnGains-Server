import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { pool } from "../../../../config/database.js"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("bodyStats routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("bstat")
    // bodyfat needs a height the /profile route can't set
    await pool.execute("UPDATE users SET height_cm = 180, bf_formula_sex = 'male' WHERE uuid = ?", [
      u.user.id,
    ])
  })

  it("logs, lists, and deletes weight", async () => {
    const bad = await request(app).post("/api/tracking/bodystats/weight").set(auth(u.token)).send({ weightKg: 10 })
    expect(bad.status).toBe(400)
    const heavy = await request(app).post("/api/tracking/bodystats/weight").set(auth(u.token)).send({ weightKg: 501 })
    expect(heavy.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/bodystats/weight")
      .set(auth(u.token))
      .send({ weightKg: 70.5 })
    expect(ok.status).toBe(201)
    const id = ok.body.id

    const current = await request(app).get("/api/tracking/bodystats/weight/current").set(auth(u.token))
    expect(current.body.entry).not.toBeNull()
    expect(current.body.entry.value).toBe(70.5)

    const history = await request(app).get("/api/tracking/bodystats/weight?limit=5").set(auth(u.token))
    expect(history.body.entries.length).toBe(1)

    const del = await request(app).delete(`/api/tracking/bodystats/weight/${id}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/bodystats/weight/${id}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })

  it("logs bodyfat with validation and deletes it", async () => {
    const noMeasure = await request(app)
      .post("/api/tracking/bodystats/bodyfat/log")
      .set(auth(u.token))
      .send({ percentage: 15 })
    expect(noMeasure.status).toBe(400)

    const badPct = await request(app)
      .post("/api/tracking/bodystats/bodyfat/log")
      .set(auth(u.token))
      .send({ percentage: 150, measurements: { waist: 80, neck: 38 } })
    expect(badPct.status).toBe(400)

    const waistLeNeck = await request(app)
      .post("/api/tracking/bodystats/bodyfat/log")
      .set(auth(u.token))
      .send({ percentage: 15, measurements: { waist: 30, neck: 38 } })
    expect(waistLeNeck.status).toBe(400)

    const femaleNoHip = await request(app)
      .post("/api/tracking/bodystats/bodyfat/log")
      .set(auth(u.token))
      .send({ percentage: 15, bfFormulaSex: "female", measurements: { waist: 80, neck: 38 } })
    expect(femaleNoHip.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/bodystats/bodyfat/log")
      .set(auth(u.token))
      .send({ percentage: 15, measurements: { waist: 80, neck: 38, unit: "cm" } })
    expect(ok.status).toBe(200)
    const id = ok.body.entry.id

    const history = await request(app).get("/api/tracking/bodystats/bodyfat/log").set(auth(u.token))
    expect(history.body.entries.length).toBe(1)

    const del = await request(app).delete(`/api/tracking/bodystats/bodyfat/log/${id}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/bodystats/bodyfat/log/${id}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
