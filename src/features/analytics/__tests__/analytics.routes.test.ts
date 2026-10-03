import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("analytics routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("analy")
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(u.token))
      .send({ dayNumber: 1, dayTitle: "Analytics Day", split: "push" })
    const sid = start.body.session.id
    await request(app)
      .post(`/api/sessions/${sid}/set`)
      .set(auth(u.token))
      .send({
        exerciseName: "Bench", setIndex: 0,
        startTime: "2024-03-01T10:00:00Z", endTime: "2024-03-01T10:00:40Z",
        weight: 80, reps: 8,
      })
    await request(app)
      .post(`/api/sessions/${sid}/set`)
      .set(auth(u.token))
      .send({
        exerciseName: "Bench", setIndex: 1,
        startTime: "2024-03-01T10:02:00Z", endTime: "2024-03-01T10:02:45Z",
        weight: 90, reps: 10,
      })
    await request(app).post(`/api/sessions/${sid}/end`).set(auth(u.token)).send({})
  })

  it("401s without a token", async () => {
    expect((await request(app).get("/api/analytics")).status).toBe(401)
  })

  it("rejects a bad dayNumber", async () => {
    const res = await request(app).get("/api/analytics?dayNumber=0").set(auth(u.token))
    expect(res.status).toBe(400)
  })

  it("aggregates ended sessions", async () => {
    const res = await request(app).get("/api/analytics").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.totalSessions).toBe(1)
    expect(res.body.totalSetsCompleted).toBe(2)
    expect(res.body.totalVolume).toBe(80 * 8 + 90 * 10)
    expect(res.body.firstSession).toBeTruthy()
    expect(res.body.lastSession).toBeTruthy()
  })

  it("filters by day", async () => {
    const day2 = await request(app).get("/api/analytics?dayNumber=2").set(auth(u.token))
    expect(day2.status).toBe(200)
    expect(day2.body.totalSessions).toBe(0)

    const day1 = await request(app).get("/api/analytics?dayNumber=1").set(auth(u.token))
    expect(day1.body.totalSessions).toBe(1)
  })
})
