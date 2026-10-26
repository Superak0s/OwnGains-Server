import { describe, it, expect, afterEach, vi } from "vitest"
import express from "express"
import request from "supertest"
import { app } from "../app.js"
import { requireUser } from "../auth.js"
import { errorHandler } from "../../middleware/errorHandler.js"
import { marketplaceConfig } from "../env.js"
import { stubAuthServer, fakeUser, bearer } from "./authStub.js"

const probe = express()
probe.get("/probe", requireUser, (_req, res) => {
  res.json({ user: res.locals.marketUser })
})
probe.use(errorHandler)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /healthz", () => {
  it("advertises the trusted auth server origin", async () => {
    const res = await request(app).get("/healthz")
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("ok")
    expect(res.body.authServer).toBe(new URL(marketplaceConfig.authServerUrl).origin)
  })
})

describe("requireUser", () => {
  it("rejects a request without a token", async () => {
    stubAuthServer([])
    expect((await request(probe).get("/probe")).status).toBe(401)
  })

  it("rejects a token the auth server refuses", async () => {
    stubAuthServer([])
    expect((await request(probe).get("/probe").set(bearer(fakeUser("ghost")))).status).toBe(401)
  })

  it("answers 503 when the auth server is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed")
    })
    expect((await request(probe).get("/probe").set(bearer(fakeUser("net")))).status).toBe(503)
  })

  it("accepts a valid token and caches the answer", async () => {
    const user = fakeUser("mara", true)
    const calls = stubAuthServer([user])
    const first = await request(probe).get("/probe").set(bearer(user))
    expect(first.status).toBe(200)
    expect(first.body.user).toEqual({ uuid: user.uuid, username: "mara", isAdmin: true })
    await request(probe).get("/probe").set(bearer(user))
    expect(calls.count).toBe(1)
  })
})
