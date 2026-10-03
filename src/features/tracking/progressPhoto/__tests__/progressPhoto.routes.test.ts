import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import sharp from "sharp"
import type { RowDataPacket } from "mysql2"
import { pool } from "@/config/database.js"
import { tryAcquireDecodeSlot, MAX_CONCURRENT_DECODES } from "@/middleware/imageUpload.js"
import { photoQuota, readSizeEnv } from "../progressPhoto.model.js"
import { app, signup, auth } from "../../../../tests/helpers.js"

// A real (decodable) image: upload builds a thumbnail from it. 800x600 so the
// thumbnail visibly shrinks.
const PNG = await sharp({
  create: { width: 800, height: 600, channels: 3, background: "#336699" },
}).png().toBuffer()
// Right magic bytes, undecodable body.
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
])

describe("progressPhoto routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let photoId: number

  beforeAll(async () => {
    u = await signup("photo")
  })

  it("rejects non-image and malformed uploads", async () => {
    const text = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", Buffer.from("hello"), { filename: "a.txt", contentType: "text/plain" })
      .field("muscleGroups", JSON.stringify(["chest"]))
    expect(text.status).toBe(400)

    const lyingPng = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", Buffer.from("definitely not an image"), {
        filename: "a.png",
        contentType: "image/png",
      })
      .field("muscleGroups", JSON.stringify(["chest"]))
    expect(lyingPng.status).toBe(400)

    const noMuscles = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", JSON.stringify([]))
    expect(noMuscles.status).toBe(400)

    const badJson = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", "not-json")
    expect(badJson.status).toBe(400)

    const undecodable = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", FAKE_PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", JSON.stringify(["chest"]))
    expect(undecodable.status).toBe(400)
  })

  it("uploads, lists, serves, and deletes photos", async () => {
    const ok = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", JSON.stringify(["chest", "abs"]))
      .field("notes", "week 1")
      .field("angle", "front")
    expect(ok.status).toBe(201)
    photoId = ok.body.id

    const all = await request(app).get("/api/tracking/photos/muscle").set(auth(u.token))
    expect(all.body.data.length).toBe(1)
    expect(all.body.data[0].thumbUri).toBe(`/api/tracking/photos/muscle/${photoId}/thumb`)
    expect(ok.body.data.thumbUri).toBe(all.body.data[0].thumbUri)

    const group = await request(app)
      .get("/api/tracking/photos/muscle/group/chest")
      .set(auth(u.token))
    expect(group.body.data.length).toBe(1)

    const image = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/image`)
      .set(auth(u.token))
      .buffer(true)
    expect(image.status).toBe(200)
    // Re-encoded on upload: always a JPEG, same dimensions (under 2048px).
    expect(image.headers["content-type"]).toContain("image/jpeg")
    expect(image.body).toBeInstanceOf(Buffer)
    const imageMeta = await sharp(image.body as Buffer).metadata()
    expect([imageMeta.format, imageMeta.width, imageMeta.height]).toEqual(["jpeg", 800, 600])

    // The stored hash is the ETag, and a revalidation is a bodiless 304.
    const etag = image.headers.etag as string
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    const revalidated = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/image`)
      .set(auth(u.token))
      .set("If-None-Match", etag)
    expect(revalidated.status).toBe(304)
    const stale = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/image`)
      .set(auth(u.token))
      .set("If-None-Match", `"${"0".repeat(64)}"`)
    expect(stale.status).toBe(200)
    // A photo from before hashes were stored gets one on its first full read.
    await pool.execute(`UPDATE progress_photos SET content_hash = NULL WHERE id = ?`, [photoId])
    const legacy = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/image`)
      .set(auth(u.token))
    expect(legacy.status).toBe(200)
    expect(legacy.headers.etag).toBe(etag)
    const [[stored]] = await pool.execute<RowDataPacket[]>(
      `SELECT content_hash AS hash FROM progress_photos WHERE id = ?`,
      [photoId],
    )
    expect(`"${stored!.hash}"`).toBe(etag)

    const thumb = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/thumb`)
      .set(auth(u.token))
      .buffer(true)
    expect(thumb.status).toBe(200)
    expect(thumb.headers["content-type"]).toContain("image/jpeg")
    const meta = await sharp(thumb.body as Buffer).metadata()
    expect([meta.width, meta.height]).toEqual([400, 300])

    // A photo from before thumbnails existed gets one built on first request.
    await pool.execute(`DELETE FROM progress_photo_thumbs WHERE photo_id = ?`, [photoId])
    const lazy = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/thumb`)
      .set(auth(u.token))
    expect(lazy.status).toBe(200)

    const other = await signup("photo2")
    const foreign = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/thumb`)
      .set(auth(other.token))
    expect(foreign.status).toBe(404)

    const del = await request(app).delete(`/api/tracking/photos/muscle/${photoId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const gone = await request(app).get("/api/tracking/photos/muscle").set(auth(u.token))
    expect(gone.body.data.length).toBe(0)
  })

  it("pages by takenAt/id cursor, breaking takenAt ties by id", async () => {
    const pager = await signup("photopage")
    const up = (takenAt: string) =>
      request(app)
        .post("/api/tracking/photos/muscle")
        .set(auth(pager.token))
        .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
        .field("muscleGroups", JSON.stringify(["chest"]))
        .field("takenAt", takenAt)
    const ids: number[] = []
    for (const t of ["2024-01-01T09:00:00Z", "2024-01-02T09:00:00Z", "2024-01-02T09:00:00Z"])
      ids.push((await up(t)).body.id)
    const list = (q: string) =>
      request(app).get(`/api/tracking/photos/muscle${q}`).set(auth(pager.token))

    const p1 = await list("?limit=2")
    expect(p1.body.data.map((p: { id: number }) => p.id)).toEqual([ids[2], ids[1]])
    expect(p1.body.nextCursor).toEqual({ before: p1.body.data[1].takenAt, beforeId: String(ids[1]) })

    const { before, beforeId } = p1.body.nextCursor
    const p2 = await list(`?limit=2&before=${encodeURIComponent(before)}&beforeId=${beforeId}`)
    expect(p2.body.data.map((p: { id: number }) => p.id)).toEqual([ids[0]])
    expect(p2.body.nextCursor).toBeNull()

    // ISO form of the tied timestamp, as the spec's example sends it.
    const iso = await list(`?before=2024-01-02T09:00:00.000Z&beforeId=${ids[2]}`)
    expect(iso.body.data.map((p: { id: number }) => p.id)).toEqual([ids[1], ids[0]])

    expect((await list("?limit=abc")).status).toBe(400)
    expect((await list("?before=garbage")).status).toBe(400)
  })

  const upload = (token: string, photo: Buffer, contentType = "image/png") =>
    request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(token))
      .attach("photo", photo, { filename: "a", contentType })
      .field("muscleGroups", JSON.stringify(["chest"]))

  it("caps multipart fields before any handler runs", async () => {
    const tooMany = request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
    for (let i = 0; i < 9; i++) tooMany.field(`f${i}`, "x")
    expect((await tooMany).status).toBe(400)

    const tooBig = await upload(u.token, PNG).field("note", "x".repeat(5000))
    expect(tooBig.status).toBe(400)

    const longName = await upload(u.token, PNG).field("x".repeat(100), "x")
    expect(longName.status).toBe(400)
  })

  it("refuses a small file that declares too many pixels, before decoding it", async () => {
    // 48 MP of one colour compresses to ~140 KB: well under the byte cap,
    // far over the 40 MP decode cap.
    const huge = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: "#000" },
    }).png({ compressionLevel: 9 }).toBuffer()
    expect(huge.length).toBeLessThan(1024 * 1024)
    const res = await upload(u.token, huge)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe("IMAGE_TOO_LARGE")
  })

  it("strips EXIF from the stored original and bounds it to 2048px", async () => {
    const owner = await signup("photoexif")
    const withExif = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: "#884422" },
    })
      .jpeg()
      .withExif({ IFD0: { Make: "TestCam", Model: "Serial-1234" } })
      .toBuffer()
    expect((await sharp(withExif).metadata()).exif).toBeDefined()

    const res = await upload(owner.token, withExif, "image/jpeg")
    expect(res.status).toBe(201)
    const image = await request(app)
      .get(`/api/tracking/photos/muscle/${res.body.id}/image`)
      .set(auth(owner.token))
      .buffer(true)
    const meta = await sharp(image.body as Buffer).metadata()
    expect(meta.exif).toBeUndefined()
    expect([meta.width, meta.height]).toEqual([2048, 683])
    expect((image.body as Buffer).includes(Buffer.from("Serial-1234"))).toBe(false)
  })

  it("enforces the per-user and instance-wide quotas", async () => {
    const owner = await signup("photoquota")
    const saved = { ...photoQuota }
    try {
      photoQuota.perUserMb = 0.001 // ~1 KB: smaller than any photo
      const perUser = await upload(owner.token, PNG)
      expect(perUser.status).toBe(400)
      expect(perUser.body.code).toBe("PHOTO_QUOTA_EXCEEDED")

      photoQuota.perUserMb = 0
      photoQuota.totalGb = 1e-9 // one byte
      const total = await upload(owner.token, PNG)
      expect(total.status).toBe(507)
    } finally {
      Object.assign(photoQuota, saved)
    }
    const [[row]] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM progress_photos p JOIN users us ON us.id = p.user_id
       WHERE us.username = ?`,
      [owner.username],
    )
    expect(Number(row!.n)).toBe(0)
  })

  it("answers 503 when every decode slot is taken, without reading the body", async () => {
    const held = []
    for (let r = tryAcquireDecodeSlot(); r; r = tryAcquireDecodeSlot()) held.push(r)
    expect(held.length).toBe(MAX_CONCURRENT_DECODES)
    try {
      const res = await upload(u.token, PNG)
      expect(res.status).toBe(503)
      expect(res.headers["retry-after"]).toBe("5")
    } finally {
      held.forEach((release) => release())
    }
    expect((await upload(u.token, PNG)).status).toBe(201)
  })
})

describe("readSizeEnv", () => {
  it("defaults when unset or blank and fails loudly on garbage", () => {
    const key = "OWNGAINS_TEST_SIZE_ENV"
    try {
      delete process.env[key]
      expect(readSizeEnv(key, 7)).toBe(7)
      process.env[key] = " "
      expect(readSizeEnv(key, 7)).toBe(7)
      process.env[key] = "0"
      expect(readSizeEnv(key, 7)).toBe(0)
      process.env[key] = "250"
      expect(readSizeEnv(key, 7)).toBe(250)
      for (const bad of ["abc", "-1", "Infinity"]) {
        process.env[key] = bad
        expect(() => readSizeEnv(key, 7)).toThrow(key)
      }
    } finally {
      delete process.env[key]
    }
  })
})
