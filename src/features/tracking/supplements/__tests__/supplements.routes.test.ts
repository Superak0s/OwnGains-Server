import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { pool } from "@/config/database.js"
import { app, signup, auth, internalId } from "../../../../tests/helpers.js"

describe("supplements routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let supplementId: number

  beforeAll(async () => {
    u = await signup("supp")
  })

  it("creates supplements with validation", async () => {
    const noName = await request(app).post("/api/tracking/supplements").set(auth(u.token)).send({})
    expect(noName.status).toBe(400)

    const badTime = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "Vitamin D", reminderTime: "9am" })
    expect(badTime.status).toBe(400)

    const badColor = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "Vitamin D", color: "red" })
    expect(badColor.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "Vitamin D", unit: "IU", defaultAmount: 2000, color: "#FF5733" })
    expect(ok.status).toBe(201)
    supplementId = ok.body.supplement.id
  })

  it("lists and updates supplements", async () => {
    const list = await request(app).get("/api/tracking/supplements").set(auth(u.token))
    expect(list.body.supplements.length).toBe(1)

    const update = await request(app)
      .patch(`/api/tracking/supplements/${supplementId}`)
      .set(auth(u.token))
      .send({ name: "Vit D" })
    expect(update.status).toBe(200)
    expect(update.body.supplement.name).toBe("Vit D")

    const missing = await request(app).patch("/api/tracking/supplements/999999").set(auth(u.token)).send({})
    expect(missing.status).toBe(404)
  })

  it("supports multiple doses per day", async () => {
    for (const bad of [{ dosesPerDay: 0 }, { dosesPerDay: 11 }, { dosesPerDay: 2.5 }, { dosesPerDay: null }]) {
      const res = await request(app).post("/api/tracking/supplements").set(auth(u.token)).send({ name: "C", ...bad })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("dosesPerDay must be an integer between 1 and 10")
    }
    const badInterval = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "C", doseIntervalMinutes: 1441 })
    expect(badInterval.body.error).toBe("doseIntervalMinutes must be an integer between 1 and 1440, or null")

    const created = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "Creatine", dosesPerDay: 3, doseIntervalMinutes: 240 })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({
      dosesPerDay: 3,
      doseIntervalMinutes: 240,
      takenToday: false,
      dosesToday: 0,
      lastTakenAt: null,
      streak: 0,
    })
    const id = created.body.data.id

    await request(app).post(`/api/tracking/supplements/${id}/log`).set(auth(u.token)).send({})
    await request(app).post(`/api/tracking/supplements/${id}/log`).set(auth(u.token)).send({})

    const list = await request(app).get("/api/tracking/supplements").set(auth(u.token))
    const row = list.body.data.find((s: { id: number }) => s.id === id)
    expect(row).toMatchObject({ takenToday: true, dosesToday: 2, streak: 1 })
    expect(row.lastTakenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/)

    const cleared = await request(app)
      .patch(`/api/tracking/supplements/${id}`)
      .set(auth(u.token))
      .send({ doseIntervalMinutes: null })
    expect(cleared.body.data).toMatchObject({ dosesPerDay: 3, doseIntervalMinutes: null, dosesToday: 2 })

    await request(app).delete(`/api/tracking/supplements/${id}`).set(auth(u.token))
  })

  it("logs doses, tracks streaks, and deletes", async () => {
    const badAmount = await request(app)
      .post(`/api/tracking/supplements/${supplementId}/log`)
      .set(auth(u.token))
      .send({ amount: -5 })
    expect(badAmount.status).toBe(400)

    const log = await request(app)
      .post(`/api/tracking/supplements/${supplementId}/log`)
      .set(auth(u.token))
      .send({ amount: 2000 })
    expect(log.status).toBe(201)
    const entryId = log.body.id
    expect(log.body.streak).toBeGreaterThanOrEqual(1)

    const history = await request(app)
      .get(`/api/tracking/supplements/${supplementId}/log`)
      .set(auth(u.token))
    expect(history.status).toBe(200)
    expect(history.body.entries.length).toBe(1)
    expect(history.body.takenToday).toBe(true)

    const delEntry = await request(app)
      .delete(`/api/tracking/supplements/${supplementId}/log/${entryId}`)
      .set(auth(u.token))
    expect(delEntry.status).toBe(200)

    const del = await request(app).delete(`/api/tracking/supplements/${supplementId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/supplements/${supplementId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })

  it("caps supplements at 100 per user and log notes at 1000 characters", async () => {
    const c = await signup("suppcap")
    const userId = await internalId(c.user.id)
    await pool.query(`INSERT INTO supplements (user_id, name) VALUES ?`, [
      Array.from({ length: 99 }, (_, i) => [userId, `S${i}`]),
    ])
    const hundredth = await request(app).post("/api/tracking/supplements").set(auth(c.token)).send({ name: "Last" })
    expect(hundredth.status).toBe(201)
    const over = await request(app).post("/api/tracking/supplements").set(auth(c.token)).send({ name: "Over" })
    expect(over.status).toBe(400)
    expect(over.body.code).toBe("SUPPLEMENT_LIMIT")

    const id = hundredth.body.data.id
    const longNote = await request(app)
      .post(`/api/tracking/supplements/${id}/log`)
      .set(auth(c.token))
      .send({ note: "x".repeat(1001) })
    expect(longNote.status).toBe(400)
  })
})
