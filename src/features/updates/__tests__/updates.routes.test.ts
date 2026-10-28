import { describe, it, expect, beforeAll, afterAll } from "vitest"
import express from "express"
import request from "supertest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import updatesRoutes from "../updates.routes.js"
import { errorHandler } from "@/middleware/errorHandler.js"

const app = express().use("/api/updates", updatesRoutes).use(errorHandler)
const headers = {
  "expo-protocol-version": "1",
  "expo-platform": "android",
  "expo-runtime-version": "abc123",
  "expo-channel-name": "play",
}
// Odd spacing on purpose: the body must be the file's bytes, not re-serialized JSON.
const MANIFEST = '{ "id":"new" ,"launchAsset":{} }'

describe("OTA updates", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ota-"))
    for (const stamp of ["2026-01-01T00-00-00-000Z", "2026-02-01T00-00-00-000Z"]) {
      const dir = path.join(root, "abc123", "play", stamp)
      await mkdir(path.join(dir, "_expo"), { recursive: true })
      await writeFile(path.join(dir, "manifest.json"), stamp.startsWith("2026-02") ? MANIFEST : "{}")
      await writeFile(path.join(dir, "expo-signature"), 'sig=":abc:", keyid="main"\n')
      await writeFile(path.join(dir, "_expo", "bundle.hbc"), "js")
    }
    process.env.UPDATES_DIR = root
  })
  afterAll(async () => {
    delete process.env.UPDATES_DIR
    await rm(root, { recursive: true, force: true })
  })

  it("serves the newest manifest byte for byte with its signature", async () => {
    const res = await request(app).get("/api/updates/manifest").set(headers).buffer(true).parse((r, cb) => {
      let s = ""
      r.on("data", (d: Buffer) => (s += d)).on("end", () => cb(null, s))
    })
    expect(res.status).toBe(200)
    expect(res.headers["expo-protocol-version"]).toBe("1")
    expect(res.headers["cache-control"]).toBe("private, max-age=0")
    const boundary = /boundary=(\w+)/.exec(res.headers["content-type"])![1]
    expect(res.body).toBe(
      `--${boundary}\r\ncontent-disposition: form-data; name="manifest"\r\n` +
        `content-type: application/json; charset=utf-8\r\n` +
        `expo-signature: sig=":abc:", keyid="main"\r\n\r\n${MANIFEST}\r\n--${boundary}--\r\n`,
    )
  })

  it("answers 204, 400 and 406 as the protocol expects", async () => {
    const get = (h: object) => request(app).get("/api/updates/manifest").set({ ...headers, ...h })
    expect((await get({ "expo-channel-name": "github" })).status).toBe(204)
    expect((await get({ "expo-runtime-version": "fff" })).status).toBe(204)
    expect((await get({ "expo-runtime-version": "../x" })).status).toBe(400)
    expect((await get({ "expo-platform": "ios" })).status).toBe(400)
    expect((await get({ "expo-channel-name": "beta" })).status).toBe(400)
    expect((await get({ "expo-protocol-version": "0" })).status).toBe(406)
    delete process.env.UPDATES_DIR
    expect((await get({})).status).toBe(204)
    process.env.UPDATES_DIR = root
  })

  it("serves assets immutably and nothing outside the update", async () => {
    const base = "/api/updates/assets/abc123/play/2026-01-01T00-00-00-000Z"
    const ok = await request(app).get(`${base}/_expo/bundle.hbc`)
    expect(ok.status).toBe(200)
    expect(ok.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
    for (const p of ["/manifest.json", "/expo-signature", "/_expo/missing.js", "/..%2F..%2F..%2Fabc123", "/../2026-02-01T00-00-00-000Z/manifest.json"])
      expect((await request(app).get(base + p)).status, p).toBe(404)
  })
})
