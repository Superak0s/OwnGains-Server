// uploadPhoto's own checks, which multer and the route normally stop first,
// plus a file whose header reads but whose pixels don't, and the instance quota
// when it has room.
import { describe, it, expect, beforeAll, afterEach } from "vitest"
import sharp from "sharp"
import { signup, internalId } from "../../../../tests/helpers.js"
import { uploadPhoto, getAllPhotos, getPhotoHash, photoQuota } from "../progressPhoto.model.js"

const meta = (extra: Record<string, unknown> = {}) => ({ muscleGroups: ["chest"], note: null, angle: "front", customSideName: null, ...extra })
let userId: number
let png: Buffer
const totalGb = photoQuota.totalGb

beforeAll(async () => {
  userId = await internalId((await signup("ppedge")).user.id)
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).png().toBuffer()
})
afterEach(() => {
  photoQuota.totalGb = totalGb
})

describe("progress photo model edges", () => {
  it.each<[string, () => Parameters<typeof uploadPhoto>, string]>([
    ["an empty buffer", () => [userId, Buffer.alloc(0), "image/png", meta()], "Invalid photo data"],
    ["an oversized buffer", () => [userId, Buffer.alloc(11 * 1024 * 1024), "image/png", meta()], "exceeds"],
    ["a bad type", () => [userId, png, "image/gif", meta()], "Invalid image type"],
    ["a bad angle", () => [userId, png, "image/png", meta({ angle: "top" })], "Invalid angle"],
    ["too many muscles", () => [userId, png, "image/png", meta({ muscleGroups: Array(21).fill("x") })], "Between 1 and 20"],
    ["no muscles", () => [userId, png, "image/png", meta({ muscleGroups: [] })], "Between 1 and 20"],
    ["an empty muscle", () => [userId, png, "image/png", meta({ muscleGroups: [""] })], "Invalid muscle group"],
    ["a truncated file", () => [userId, png.subarray(0, png.length - 20), "image/png", meta()], "Invalid image data"],
  ])("rejects %s", async (_n, args, message) => {
    await expect(uploadPhoto(...args())).rejects.toThrow(message)
  })

  it("stores under an instance quota with room, and lists its muscles", async () => {
    photoQuota.totalGb = 1000
    const id = await uploadPhoto(userId, png, "image/png", meta())
    expect((await getAllPhotos(userId)).data).toEqual([expect.objectContaining({ id, muscleGroups: ["chest"] })])
    await expect(getPhotoHash(userId, 999_999_999)).rejects.toThrow("Photo")
  })
})
