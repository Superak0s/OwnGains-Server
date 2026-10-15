import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import sharp from "sharp"
import { app, signup, auth } from "../../../tests/helpers.js"

const PNG = await sharp({
  create: { width: 1200, height: 900, channels: 3, background: "#336699" },
}).png().toBuffer()

describe("profilePhoto routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let other: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("avatar")
    other = await signup("avatar2")
  })

  it("404s before any upload and rejects a non-image", async () => {
    expect((await request(app).get("/api/profile/photo").set(auth(u.token))).status).toBe(404)
    const bad = await request(app)
      .put("/api/profile/photo")
      .set(auth(u.token))
      .attach("photo", Buffer.from("nope"), { filename: "a.png", contentType: "image/png" })
    expect(bad.status).toBe(400)
  })

  it("stores a resized JPEG, revalidates by ETag, replaces and deletes it", async () => {
    const put = await request(app)
      .put("/api/profile/photo")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
    expect(put.status).toBe(200)

    const get = await request(app).get("/api/profile/photo").set(auth(u.token)).buffer(true)
    expect(get.status).toBe(200)
    expect(get.headers["content-type"]).toBe("image/jpeg")
    const meta = await sharp(get.body as Buffer).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(400)
    expect(get.headers.etag).toBe(`"${put.body.data.hash}"`)

    const cached = await request(app)
      .get("/api/profile/photo")
      .set(auth(u.token))
      .set("If-None-Match", get.headers.etag)
    expect(cached.status).toBe(304)

    expect((await request(app).get("/api/profile/photo").set(auth(other.token))).status).toBe(404)

    const replaced = await request(app)
      .put("/api/profile/photo")
      .set(auth(u.token))
      .attach("photo", await sharp(PNG).negate().png().toBuffer(), { filename: "b.png", contentType: "image/png" })
    expect(replaced.body.data.hash).not.toBe(put.body.data.hash)

    expect((await request(app).delete("/api/profile/photo").set(auth(u.token))).status).toBe(200)
    expect((await request(app).delete("/api/profile/photo").set(auth(u.token))).status).toBe(200)
    expect((await request(app).get("/api/profile/photo").set(auth(u.token))).status).toBe(404)
  })
})

describe("friend profile photos", () => {
  it("serves a photo to accepted friends only and lists its hash", async () => {
    const owner = await signup("pfown")
    const friend = await signup("pffr")
    const stranger = await signup("pfst")
    const put = await request(app)
      .put("/api/profile/photo")
      .set(auth(owner.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
    const path = `/api/profile/photo/${owner.user.id}`

    expect((await request(app).get(path).set(auth(friend.token))).status).toBe(404)

    const req = await request(app).post("/api/friends/request").set(auth(owner.token)).send({ username: friend.username })
    await request(app).post(`/api/friends/request/${req.body.friendshipId}/accept`).set(auth(friend.token))

    const seen = await request(app).get(path).set(auth(friend.token))
    expect(seen.status).toBe(200)
    expect(seen.headers.etag).toBe(`"${put.body.data.hash}"`)
    expect((await request(app).get(path).set(auth(owner.token))).status).toBe(200)
    expect((await request(app).get(path).set(auth(stranger.token))).status).toBe(404)
    expect((await request(app).get("/api/profile/photo/not-a-uuid").set(auth(friend.token))).status).toBe(400)

    const list = await request(app).get("/api/friends").set(auth(friend.token))
    expect(list.body.friends[0].photoHash).toBe(put.body.data.hash)
  })
})
