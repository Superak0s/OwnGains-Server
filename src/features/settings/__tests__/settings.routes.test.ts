import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("settings routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("set")
  })

  it("creates the row on first read with schema defaults", async () => {
    const res = await request(app).get("/api/settings").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.data.hydrationGoalMl).toBeGreaterThan(0)
  })

  it("patches a subset and leaves the rest alone", async () => {
    const before = await request(app).get("/api/settings").set(auth(u.token))

    const res = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: 3000 })
    expect(res.status).toBe(200)
    expect(res.body.data.hydrationGoalMl).toBe(3000)
    expect(res.body.data.macroProteinGoal).toBe(before.body.data.macroProteinGoal)
  })

  // A typo'd key used to 200 with nothing written, so the client believed it saved.
  it("rejects unknown keys, naming the known ones", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMI: 3000 })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("hydrationGoalMl")
  })

  it("rejects a fraction for an integer column, but allows one elsewhere", async () => {
    const frac = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: 2500.5 })
    expect(frac.status).toBe(400)

    const ok = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationErrorPercent: 12.5 })
    expect(ok.status).toBe(200)
    expect(Number(ok.body.data.hydrationErrorPercent)).toBe(12.5)
  })

  it("rejects negatives, non-numbers, an empty patch, and anonymous callers", async () => {
    for (const body of [{ hydrationGoalMl: -1 }, { hydrationGoalMl: "3000" }, {}])
      expect(
        (await request(app).patch("/api/settings").set(auth(u.token)).send(body)).status,
      ).toBe(400)

    expect((await request(app).get("/api/settings")).status).toBe(401)
  })

  // ck_us_* in schema.sql are the real range rules: a violation is a 400, not a 500.
  it("turns a CHECK violation into a 400", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ cyclePeriodDays: 40, cycleLengthDays: 20 })
    expect(res.status).toBe(400)
  })
})
