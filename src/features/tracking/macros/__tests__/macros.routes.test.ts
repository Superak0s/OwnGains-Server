import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("macros routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("macr")
  })

  it("validates intake logs", async () => {
    const noTime = await request(app).post("/api/tracking/macros/log").set(auth(u.token)).send({ name: "lunch" })
    expect(noTime.status).toBe(400)

    const noFood = await request(app)
      .post("/api/tracking/macros/log")
      .set(auth(u.token))
      .send({ takenAt: "2024-06-01T12:30:00Z" })
    expect(noFood.status).toBe(400)

    const big = await request(app)
      .post("/api/tracking/macros/log")
      .set(auth(u.token))
      .send({ name: "lunch", protein: 20000, takenAt: "2024-06-01T12:30:00Z" })
    expect(big.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/macros/log")
      .set(auth(u.token))
      .send({
        name: "lunch", protein: 40, carbs: 60, calories: 700,
        // the history query is a rolling window, so this has to be recent
        takenAt: new Date().toISOString(), note: "good",
      })
    expect(ok.status).toBe(201)
    entryId = ok.body.data.id
  })

  // Macro goals are /api/settings keys now, not PUT /api/tracking/macros/goals.
  it("lists, updates goals, and deletes", async () => {
    const history = await request(app).get("/api/tracking/macros/log?days=7").set(auth(u.token))
    expect(history.body.entries.length).toBe(1)

    const bad = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ macroProteinGoal: -1 })
    expect(bad.status).toBe(400)

    const goals = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ macroProteinGoal: 150, macroCaloriesGoal: 2800 })
    expect(goals.status).toBe(200)
    expect(goals.body.data.macroProteinGoal).toBe(150)
    expect(goals.body.data.macroCaloriesGoal).toBe(2800)

    const del = await request(app).delete(`/api/tracking/macros/log/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/macros/log/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })

  it("dedupes an offline replay by Idempotency-Key", async () => {
    const takenAt = new Date(Date.now() - 3600_000).toISOString()
    const send = () =>
      request(app)
        .post("/api/tracking/macros/log")
        .set(auth(u.token))
        .set("Idempotency-Key", "macro-replay-1")
        .send({ name: "snack", protein: 10, takenAt })
    const first = await send()
    const replay = await send()
    expect(first.status).toBe(201)
    expect(replay.body.entry.id).toBe(first.body.entry.id)

    const list = await request(app).get("/api/tracking/macros/log?days=2").set(auth(u.token))
    expect(list.body.data.filter((e: any) => e.name === "snack")).toHaveLength(1)
  })
})
