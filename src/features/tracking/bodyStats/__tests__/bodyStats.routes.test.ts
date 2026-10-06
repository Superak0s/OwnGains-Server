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
    const noPct = await request(app)
      .post("/api/tracking/bodystats/bodyfat/log")
      .set(auth(u.token))
      .send({ measurements: null })
    expect(noPct.status).toBe(400)

    // Health Connect: percentage only, stored with null circumferences.
    const pctOnly = await request(app)
      .post("/api/tracking/bodystats/bodyfat/log")
      .set(auth(u.token))
      .send({ percentage: 21.4, measurements: null, measuredAt: "2026-01-05T07:00:00.000Z" })
    expect(pctOnly.status).toBe(200)
    expect(pctOnly.body.entry.measurements).toMatchObject({ waist: null, neck: null, hip: null })
    const pctOnlyHistory = await request(app).get("/api/tracking/bodystats/bodyfat/log").set(auth(u.token))
    expect(pctOnlyHistory.body.entries[0]).toMatchObject({
      percentage: 21.4,
      measurements: { waist: null, neck: null, hip: null },
    })
    await request(app).delete(`/api/tracking/bodystats/bodyfat/log/${pctOnly.body.entry.id}`).set(auth(u.token))

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
