import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { app } from "../app.js"
import { pool } from "../../config/database.js"
import { stubAuthServer, fakeUser, bearer } from "./authStub.js"
import type { RowDataPacket } from "mysql2/promise"

const a = fakeUser("alice")
const b = fakeUser("bob")

const publish = async (user = a) =>
  (
    await request(app)
      .post("/api/skins")
      .set(bearer(user))
      .send({ name: "Mint", skin: { format: 1, theme: { name: "Mint", colors: { accent: "#10b981" } } } })
  ).body.id as number

const download = (id: number, installId?: string) => {
  const r = request(app).post(`/api/skins/${id}/download`)
  return installId ? r.set("X-Install-Id", installId) : r
}

const rate = (id: number, user: ReturnType<typeof fakeUser>, stars: unknown) =>
  request(app).put(`/api/skins/${id}/rating`).set(bearer(user)).send({ stars })

beforeEach(() => {
  stubAuthServer([a, b])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("downloads", () => {
  it("counts every download but each install once", async () => {
    const id = await publish()
    const install = randomUUID()
    await download(id, install)
    expect((await download(id, install)).body).toEqual({ downloads: 2, uniqueDownloads: 1 })
    expect((await download(id, randomUUID())).body).toEqual({ downloads: 3, uniqueDownloads: 2 })
    expect((await download(id)).body).toEqual({ downloads: 4, uniqueDownloads: 2 })
  })

  it("404s for an unknown skin", async () => {
    const res = await download(999_999_999)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain("not found not found")
  })

  it("leaves updated_at alone", async () => {
    const id = await publish()
    await pool.execute("UPDATE skins SET updated_at = '2020-06-01 00:00:00' WHERE id = ?", [id])
    await download(id, randomUUID())
    await rate(id, b, 4)
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT updated_at FROM skins WHERE id = ?", [id])
    expect(new Date(rows[0].updated_at).getUTCFullYear()).toBe(2020)
  })
})

describe("ratings", () => {
  it("rejects stars outside 1 to 5", async () => {
    const id = await publish()
    expect((await rate(id, b, 6)).status).toBe(400)
    expect((await rate(id, b, 2.5)).status).toBe(400)
  })

  it("replaces the caller's earlier rating", async () => {
    const id = await publish()
    await rate(id, b, 4)
    expect((await rate(id, b, 2)).body).toEqual({ average: 2, count: 1, myRating: 2 })
  })

  it("keeps one rating per account after the account forgets itself", async () => {
    const id = await publish()
    await rate(id, b, 5)
    await request(app).delete("/api/me").set(bearer(b))
    expect((await rate(id, b, 1)).body).toEqual({ average: 1, count: 1, myRating: 1 })
  })
})

describe("reports", () => {
  it("stores a trimmed reason and rejects an empty one", async () => {
    const id = await publish()
    expect((await request(app).post(`/api/skins/${id}/report`).set(bearer(b)).send({ reason: "  " })).status).toBe(400)
    expect((await request(app).post(`/api/skins/${id}/report`).set(bearer(b)).send({ reason: " stolen " })).status).toBe(201)
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT reason FROM skin_reports WHERE skin_id = ?", [id])
    expect(rows[0].reason).toBe("stolen")
  })

  it("keeps one report per account and skin", async () => {
    const id = await publish()
    const report = () => request(app).post(`/api/skins/${id}/report`).set(bearer(b)).send({ reason: "spam" })
    await report()
    await request(app).delete("/api/me").set(bearer(b))
    expect((await report()).status).toBe(201)
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM skin_reports WHERE skin_id = ?", [id])
    expect(Number(rows[0].n)).toBe(1)
  })
})

describe("DELETE /api/me", () => {
  it("anonymizes the caller everywhere but keeps their skins and stars", async () => {
    const mine = await publish(a)
    const theirs = await publish(b)
    await rate(theirs, a, 5)
    await rate(theirs, b, 3)
    await request(app).post(`/api/skins/${theirs}/report`).set(bearer(a)).send({ reason: "test" })

    expect((await request(app).delete("/api/me").set(bearer(a))).status).toBe(204)

    const skin = await request(app).get(`/api/skins/${theirs}`)
    expect(skin.body.rating).toEqual({ average: 4, count: 2 })
    expect((await request(app).get(`/api/skins/${mine}`)).body.author).toBeNull()
    const [[counts]] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM skins WHERE author_uuid = ?", [a.uuid])
    expect(Number(counts.n)).toBe(0)
  })
})
