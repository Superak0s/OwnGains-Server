// Measurement, supplement and history-sharing rejections the per-feature
// route suites don't reach.
import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

let u: Awaited<ReturnType<typeof signup>>
beforeAll(async () => {
  u = await signup("trkroute")
})

describe("measurement routes", () => {
  const api = "/api/tracking/measurements"

  it.each<[string, object]>([
    ["values not an object", { values: [80] }],
    ["no values", { values: {} }],
  ])("rejects %s", async (_n, body) => {
    expect((await request(app).post(api).set(auth(u.token)).send(body)).status).toBe(400)
  })

  it("needs metrics to list, and deletes an entry whole or by metric", async () => {
    expect((await request(app).get(api).set(auth(u.token))).status).toBe(400)
    const log = () => request(app).post(api).set(auth(u.token)).send({ values: { waist_cm: 80, chest_cm: 100 } })
    const whole = (await log()).body.id
    expect((await request(app).delete(`${api}/${whole}`).set(auth(u.token))).status).toBe(200)
    const part = (await log()).body.id
    expect((await request(app).delete(`${api}/${part}?metrics=waist_cm`).set(auth(u.token))).status).toBe(200)
  })
})

describe("supplement routes", () => {
  const api = "/api/tracking/supplements"

  it.each<[string, object]>([
    ["a long name", { name: "x".repeat(101) }],
    ["a blank unit", { name: "Zinc", unit: " " }],
    ["a zero amount", { name: "Zinc", defaultAmount: 0 }],
  ])("rejects %s", async (_n, body) => {
    expect((await request(app).post(api).set(auth(u.token)).send(body)).status).toBe(400)
  })

  it("404s deleting a log entry that isn't there", async () => {
    const { id } = (await request(app).post(api).set(auth(u.token)).send({ name: "Zinc", unit: "mg" })).body.data
    expect((await request(app).delete(`${api}/${id}/log/999999999`).set(auth(u.token))).status).toBe(404)
  })
})

describe("sharing permission routes", () => {
  it("needs a friendId, and friendship plus a grant to read a session", async () => {
    expect((await request(app).post("/api/sharing/permissions").set(auth(u.token)).send({})).status).toBe(400)
    const other = await signup("trkfriend")
    const read = () => request(app).get(`/api/sharing/sessions/friend/${other.user.id}/1`).set(auth(u.token))
    expect((await read()).status).toBe(403)
    const req = await request(app).post("/api/friends/request").set(auth(u.token)).send({ username: other.username })
    await request(app).post(`/api/friends/request/${req.body.friendshipId}/accept`).set(auth(other.token))
    expect((await read()).body.error).toContain("history access")
  })
})
