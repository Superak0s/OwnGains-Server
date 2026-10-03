// measurements stores every scalar body metric (the pivot, the grouped delete
// and the user-defined-metric registry) and had no tests at all. These cover
// the parts nothing else in the suite reaches: the group read/delete, the
// ownership predicate on a second user's row, and the out-of-range value that
// used to reach the client as a 500.

import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

const BASE = "/api/tracking/measurements"

describe("measurements routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let other: Awaited<ReturnType<typeof signup>>
  let groupId: number

  beforeAll(async () => {
    u = await signup("meas")
    other = await signup("meas2")

    const res = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({
        values: { waist_cm: 84, chest_cm: 102 },
        measuredAt: "2026-01-05T09:00:00.000Z",
        note: "morning",
      })
    expect(res.status).toBe(201)
    groupId = res.body.id
  })

  it("pivots one measuring session into a values map", async () => {
    const res = await request(app)
      .get(`${BASE}?metrics=waist_cm,chest_cm`)
      .set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].values).toEqual({ waist_cm: 84, chest_cm: 102 })
    expect(res.body.data[0].note).toBe("morning")
  })

  it("serves one metric as a plain series", async () => {
    const res = await request(app)
      .get(`${BASE}/waist_cm/history`)
      .set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.data[0].value).toBe(84)
  })

  it("rejects a metric the caller has not defined", async () => {
    const unknown = await request(app)
      .get(`${BASE}/not_a_metric/history`)
      .set(auth(u.token))
    expect(unknown.status).toBe(400)

    const unspellable = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({ values: { "waist cm": 84 } })
    expect(unspellable.status).toBe(400)
  })

  it("answers 400, not 500, for a value the column cannot hold", async () => {
    // measurements.value is DECIMAL(10,3). 1e9 overflows it. The driver raises
    // ER_WARN_DATA_OUT_OF_RANGE, which used to fall through to a generic 500.
    const res = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({ values: { waist_cm: 1e9 } })
    expect(res.status).toBe(400)
  })

  it("overwrites rather than doubling a metric replayed at the same instant", async () => {
    // Two devices coming back from a week offline both replay the same day.
    const at = "2026-02-02T08:00:00.000Z"
    for (const kg of [80, 81]) {
      const res = await request(app)
        .post(BASE)
        .set(auth(u.token))
        .send({ values: { weight_kg: kg }, measuredAt: at })
      expect(res.status).toBe(201)
    }

    // This user logs weight_kg nowhere else, so the whole series is that day.
    const history = await request(app)
      .get(`${BASE}/weight_kg/history`)
      .set(auth(u.token))
    expect(history.body.data).toHaveLength(1)
    expect(history.body.data[0].value).toBe(81)
  })

  it("registers and uses a user-defined metric", async () => {
    const def = await request(app)
      .post(`${BASE}/definitions`)
      .set(auth(u.token))
      .send({ keyName: "grip_kg", label: "Grip strength", unit: "kg" })
    expect(def.status).toBe(201)

    const dupe = await request(app)
      .post(`${BASE}/definitions`)
      .set(auth(u.token))
      .send({ keyName: "grip_kg", label: "Grip strength" })
    expect(dupe.status).toBe(409)

    const log = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({ values: { grip_kg: 52 } })
    expect(log.status).toBe(201)

    // The definition is per-user, so the other account cannot log against it.
    const trespass = await request(app)
      .post(BASE)
      .set(auth(other.token))
      .send({ values: { grip_kg: 52 } })
    expect(trespass.status).toBe(400)
  })

  it("scopes every :id operation to the owner", async () => {
    const theirs = await request(app)
      .delete(`${BASE}/${groupId}`)
      .set(auth(other.token))
    expect(theirs.status).toBe(404)

    // ...and the row is still there for its actual owner.
    const still = await request(app)
      .get(`${BASE}?metrics=waist_cm`)
      .set(auth(u.token))
    expect(still.body.data).toHaveLength(1)
  })

  it("deletes the whole measuring session when ?metrics= is given", async () => {
    const del = await request(app)
      .delete(`${BASE}/${groupId}?metrics=waist_cm,chest_cm`)
      .set(auth(u.token))
    expect(del.status).toBe(200)

    const left = await request(app)
      .get(`${BASE}?metrics=waist_cm,chest_cm`)
      .set(auth(u.token))
    expect(left.body.data).toHaveLength(0)

    const again = await request(app)
      .delete(`${BASE}/${groupId}`)
      .set(auth(u.token))
    expect(again.status).toBe(404)
  })

  it("pivots several sessions newest first, nulls for missing metrics, limit on sessions", async () => {
    const p = await signup("measpiv")
    const log = (values: Record<string, number>, measuredAt: string, note?: string) =>
      request(app).post(BASE).set(auth(p.token)).send({ values, measuredAt, note }).expect(201)
    const s1 = await log({ waist_cm: 90, hip_cm: 100 }, "2026-01-01T09:00:00.000Z", "one")
    await log({ waist_cm: 89 }, "2026-01-02T09:00:00.000Z")
    await log({ neck_cm: 40 }, "2026-01-03T09:00:00.000Z") // not asked for below

    const res = await request(app)
      .get(`${BASE}?metrics=waist_cm,hip_cm`)
      .set(auth(p.token))
    expect(res.body.data.map((d: { values: object }) => d.values)).toEqual([
      { waist_cm: 89, hip_cm: null },
      { waist_cm: 90, hip_cm: 100 },
    ])
    expect(res.body.data[1]).toMatchObject({ id: s1.body.id, note: "one" })
    expect(Object.keys(res.body.data[0])).toEqual(["id", "measuredAt", "note", "values"])

    const limited = await request(app)
      .get(`${BASE}?metrics=waist_cm,hip_cm&limit=1`)
      .set(auth(p.token))
    expect(limited.body.data).toHaveLength(1)
    expect(limited.body.data[0].values.waist_cm).toBe(89)
  })

  it("caps metrics per query, values per entry and definitions per user", async () => {
    const c = await signup("meascap")
    const eleven = Array.from({ length: 11 }, (_, i) => `m${i}`)
    const tooManyMetrics = await request(app)
      .get(`${BASE}?metrics=${eleven.join(",")}`)
      .set(auth(c.token))
    expect(tooManyMetrics.status).toBe(400)

    const values = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m${i}`, 1]))
    const tooManyValues = await request(app).post(BASE).set(auth(c.token)).send({ values })
    expect(tooManyValues.status).toBe(400)

    for (let i = 0; i < 50; i++)
      await request(app)
        .post(`${BASE}/definitions`)
        .set(auth(c.token))
        .send({ keyName: `metric_${i}`, label: `M${i}` })
        .expect(201)
    const fiftyFirst = await request(app)
      .post(`${BASE}/definitions`)
      .set(auth(c.token))
      .send({ keyName: "metric_50", label: "M50" })
    expect(fiftyFirst.status).toBe(400)
    expect(fiftyFirst.body.code).toBe("METRIC_LIMIT")

    // Ten user-defined metrics in one read is fine, and its SQL is the same
    // statement as a read of one.
    const ten = Array.from({ length: 10 }, (_, i) => `metric_${i}`)
    const ok = await request(app).get(`${BASE}?metrics=${ten.join(",")}`).set(auth(c.token))
    expect(ok.status).toBe(200)
  })

  // The weight, hydration and body-fat ranges used to be checked only by
  // their thin routers, so the same values sent here were stored.
  it("applies the built-in metric ranges to direct writes", async () => {
    for (const values of [{ weight_kg: 5000 }, { body_fat_pct: 400 }, { water_ml: 999999 }]) {
      const res = await request(app).post(BASE).set(auth(u.token)).send({ values })
      expect(res.status).toBe(400)
    }
    const ok = await request(app).post(BASE).set(auth(u.token)).send({ values: { weight_kg: 80 } })
    expect(ok.status).toBe(201)
  })

  it("dedupes a replayed write by Idempotency-Key", async () => {
    const send = () =>
      request(app)
        .post(BASE)
        .set(auth(u.token))
        .set("Idempotency-Key", "meas-replay-1")
        .send({ values: { water_ml: 250 }, measuredAt: "2024-03-01T08:00:00Z" })
    const first = await send()
    const replay = await send()
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.body.id).toBe(first.body.id)
  })
})
