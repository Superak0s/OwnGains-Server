// Photo route paths the main suite doesn't reach: the per-account upload
// limiter (skipped under vitest), the beforeId cursor, and a busy lazy thumb.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import request from "supertest"
import sharp from "sharp"
import { pool } from "@/config/database.js"
import { tryAcquireDecodeSlot } from "@/middleware/imageUpload.js"
import { app, signup, auth } from "../../../../tests/helpers.js"

afterEach(() => vi.unstubAllEnvs())

const PNG = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer()

describe("progressPhoto route edges", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let photoId: number

  beforeAll(async () => {
    u = await signup("phedge")
  })

  it("counts uploads per account when the limiter is on", async () => {
    vi.stubEnv("VITEST", "")
    const res = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", JSON.stringify(["chest"]))
    expect(res.status).toBe(201)
    expect(res.headers["ratelimit-policy"]).toBeTruthy()
    photoId = res.body.data.id
  })

  it.each(["&beforeId=1", ""])("pages with a before cursor%s", async (extra) => {
    const res = await request(app)
      .get(`/api/tracking/photos/muscle?before=2999-01-01T00:00:00Z${extra}`)
      .set(auth(u.token))
    expect(res.status).toBe(200)
  })

  it("answers 503 for a missing thumb while every decode slot is taken", async () => {
    await pool.execute(`DELETE FROM progress_photo_thumbs WHERE photo_id = ?`, [photoId])
    const held = []
    for (let r = tryAcquireDecodeSlot(); r; r = tryAcquireDecodeSlot()) held.push(r)
    try {
      const res = await request(app).get(`/api/tracking/photos/muscle/${photoId}/thumb`).set(auth(u.token))
      expect(res.status).toBe(503)
      expect(res.headers["retry-after"]).toBe("5")
    } finally {
      held.forEach((release) => release())
    }
  })
})
