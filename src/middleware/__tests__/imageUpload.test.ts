import { describe, it, expect } from "vitest"
import { assertImageUpload } from "../imageUpload.js"

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF87 = Buffer.from("GIF87a......")
const GIF89 = Buffer.from("GIF89a......")
const WEBP = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "binary")
const GARBAGE = Buffer.from("this is not an image at all")

function file(mimetype: string, buffer: Buffer) {
  return { mimetype, buffer } as Express.Multer.File
}

describe("assertImageUpload", () => {
  it("rejects a missing file", () => {
    expect(() => assertImageUpload(undefined)).toThrow("No photo file provided")
  })

  it("accepts buffers matching the declared type", () => {
    expect(() => assertImageUpload(file("image/png", PNG))).not.toThrow()
    expect(() => assertImageUpload(file("image/jpeg", JPEG))).not.toThrow()
    expect(() => assertImageUpload(file("image/gif", GIF87))).not.toThrow()
    expect(() => assertImageUpload(file("image/gif", GIF89))).not.toThrow()
    expect(() => assertImageUpload(file("image/webp", WEBP))).not.toThrow()
  })

  it("rejects bytes that don't match the declared type", () => {
    expect(() => assertImageUpload(file("image/png", GARBAGE))).toThrow(
      "File content does not match declared image type",
    )
    expect(() => assertImageUpload(file("image/jpeg", PNG))).toThrow(
      "File content does not match declared image type",
    )
  })
})
