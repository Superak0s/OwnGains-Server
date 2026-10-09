import { describe, it, expect, vi } from "vitest"
import express from "express"
import request from "supertest"
import legalRoutes from "../legal.routes.js"

const app = express().use(legalRoutes)

describe("legal pages", () => {
  it("serves each page from GitHub with a CSP that lets its inline style apply", async () => {
    const fetchMock = vi.fn(async (url: URL) =>
      new Response(`<h1>${url.pathname}</h1>`, { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    for (const page of ["privacy-policy", "terms-of-service", "delete-account"]) {
      const res = await request(app).get(`/${page}.html`)
      expect(res.status).toBe(200)
      expect(res.type).toBe("text/html")
      expect(res.text).toContain(`/docs/${page}.html`)
      expect(res.headers["content-security-policy"]).toContain("style-src 'unsafe-inline'")
      expect(res.headers["content-security-policy"]).not.toContain("script-src")
    }
    expect((await request(app).get("/legal.routes.html")).status).toBe(404)

    // Cached, and the last good copy is still served during a GitHub outage.
    fetchMock.mockClear()
    fetchMock.mockRejectedValue(new Error("down"))
    expect((await request(app).get("/privacy-policy.html")).status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe("legal page outages", () => {
  it("serves a stale copy past its hour, and 503s a page never fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })))
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60 * 1000)
    try {
      expect((await request(app).get("/terms-of-service.html")).status).toBe(200)
    } finally {
      vi.restoreAllMocks()
    }
    // A fresh module, so nothing is cached.
    vi.resetModules()
    const fresh = express().use((await import("../legal.routes.js")).default)
    const res = await request(fresh).get("/delete-account.html")
    expect([res.status, res.headers["retry-after"]]).toEqual([503, "60"])
    vi.unstubAllGlobals()
  })
})
