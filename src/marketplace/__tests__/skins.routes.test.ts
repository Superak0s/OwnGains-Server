import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import request from "supertest"
import { app } from "../app.js"
import { pool } from "../../config/database.js"
import { stubAuthServer, fakeUser, bearer } from "./authStub.js"
import type { RowDataPacket } from "mysql2/promise"

const author = fakeUser("author")
const other = fakeUser("other")
const admin = fakeUser("admin", true)

const body = (name = "Neon Lifter") => ({
  name,
  description: "Purple and loud",
  skin: {
    format: 1,
    theme: { name: "Neon", colors: { background: "#020617", accent: "#a78bfa" } },
    boards: { home: [{ type: "todayWorkout", size: "large", order: 0 }] },
  },
})

const publish = async (b: object = body()) => request(app).post("/api/skins").set(bearer(author)).send(b)

beforeEach(() => {
  stubAuthServer([author, other, admin])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("skins CRUD", () => {
  it("publishes and returns a shareable url", async () => {
    const res = await publish()
    expect(res.status).toBe(201)
    expect(res.body.url).toBe(`https://market.test/marketplace/skins/${res.body.id}`)
  })

  it("serves a skin anonymously with author and summary fields", async () => {
    const { body: created } = await publish()
    const res = await request(app).get(`/api/skins/${created.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: created.id,
      name: "Neon Lifter",
      author: "author",
      version: 1,
      hasTheme: true,
      hasBoards: true,
      swatch: ["#020617", "#a78bfa"],
      downloads: 0,
      uniqueDownloads: 0,
      rating: { average: null, count: 0 },
      myRating: null,
      mine: false,
    })
    expect(res.body.skin.boards.home[0].type).toBe("todayWorkout")
  })

  it("marks the caller's own skin as mine", async () => {
    const { body: created } = await publish()
    const res = await request(app).get(`/api/skins/${created.id}`).set(bearer(author))
    expect(res.body.mine).toBe(true)
  })

  it("rejects a body over the size limit", async () => {
    const huge = body()
    huge.description = "x".repeat(100_000)
    expect((await publish(huge)).status).toBe(413)
  })

  it("lets only the author update, bumping the version", async () => {
    const { body: created } = await publish()
    const denied = await request(app).put(`/api/skins/${created.id}`).set(bearer(other)).send(body("Taken"))
    expect(denied.status).toBe(403)
    const res = await request(app).put(`/api/skins/${created.id}`).set(bearer(author)).send(body("Neon v2"))
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(2)
  })

  it("matches % in a search literally", async () => {
    const tag = `pct${Date.now()}`
    await publish(body(`${tag} 100% purple`))
    await publish(body(`${tag} plain`))
    const res = await request(app).get("/api/skins").query({ q: `${tag} 100%` })
    expect(res.body.skins.map((s: { name: string }) => s.name)).toEqual([`${tag} 100% purple`])
  })

  it("hides a skin an admin takes down but keeps the row", async () => {
    const { body: created } = await publish()
    expect((await request(app).delete(`/api/skins/${created.id}`).set(bearer(other))).status).toBe(403)
    expect((await request(app).delete(`/api/skins/${created.id}`).set(bearer(admin))).status).toBe(204)
    expect((await request(app).get(`/api/skins/${created.id}`)).status).toBe(404)
    const list = await request(app).get("/api/skins").query({ sort: "new" })
    expect(list.body.skins.some((s: { id: number }) => s.id === created.id)).toBe(false)
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT taken_down_at FROM skins WHERE id = ?", [created.id])
    expect(rows[0].taken_down_at).not.toBeNull()
  })

  it("removes a skin its author deletes", async () => {
    const { body: created } = await publish()
    expect((await request(app).delete(`/api/skins/${created.id}`).set(bearer(author))).status).toBe(204)
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT id FROM skins WHERE id = ?", [created.id])
    expect(rows).toHaveLength(0)
  })

  it("lists only the caller's skins with mine=1", async () => {
    await request(app).post("/api/skins").set(bearer(other)).send(body("Other's"))
    const { body: created } = await publish()
    const res = await request(app).get("/api/skins").query({ mine: 1 }).set(bearer(author))
    expect(res.status).toBe(200)
    expect(res.body.skins.every((s: { author: string }) => s.author === "author")).toBe(true)
    expect(res.body.skins.some((s: { id: number }) => s.id === created.id)).toBe(true)
  })

  it("requires a token for mine=1", async () => {
    expect((await request(app).get("/api/skins").query({ mine: 1 })).status).toBe(401)
  })
})
