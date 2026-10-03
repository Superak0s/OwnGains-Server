import { describe, it, expect, vi } from "vitest"
import express from "express"
import request from "supertest"
import packageJson from "../../package.json" with { type: "json" }
import { app, signup, auth } from "../tests/helpers.js"

describe("app-level routes", () => {
  it("GET /healthz is public and checks the DB", async () => {
    const res = await request(app).get("/healthz")
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("OK")
  })

  it("answers 410 for routes of features in LOCAL_ONLY_FEATURES", async () => {
    process.env.LOCAL_ONLY_FEATURES = "tracking,supplements"
    vi.resetModules()
    const { registerRoutes, localOnlyFeatures } = await import("../routes.js")
    const gated = express()
    registerRoutes(gated)
    gated.use((_req, res) => res.status(404).json({ success: false }))
    delete process.env.LOCAL_ONLY_FEATURES

    expect(localOnlyFeatures).toEqual(["tracking", "supplements"])
    expect((await request(gated).get("/api/tracking/hydration")).status).toBe(410)
    expect((await request(gated).get("/api/tracking/supplements")).status).toBe(410)
    // Everything else still routes. Without a token it is 401, not 410.
    expect((await request(gated).get("/api/sessions")).status).toBe(401)
  })

  it("unknown API routes 404", async () => {
    const res = await request(app).get("/api/definitely-not-a-route")
    expect(res.status).toBe(404)
    expect(res.body.error).toBe("Route not found")
  })

  it("GET /api/version requires auth and reports the package version", async () => {
    expect((await request(app).get("/api/version")).status).toBe(401)

    const u = await signup("vers")
    const res = await request(app).get("/api/version").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(packageJson.version)
  })

  // Guards the middleware order as much as the dependency: compression() has to
  // run before registerRoutes(app) to see a route's response at all.
  it("gzips JSON responses over the 1kb threshold", async () => {
    const u = await signup("gzip")
    // Notes are capped at 1000 characters, so two of them pass the threshold.
    for (let i = 0; i < 2; i++)
      await request(app)
        .post("/api/tracking/personal-notes")
        .set(auth(u.token))
        .send({ muscleGroup: "chest", content: "x".repeat(1000) })
        .expect(201)

    const res = await request(app)
      .get("/api/tracking/personal-notes/muscle/chest")
      .set(auth(u.token))
      .set("Accept-Encoding", "gzip")
    expect(res.status).toBe(200)
    expect(res.headers["content-encoding"]).toBe("gzip")
  })
})
