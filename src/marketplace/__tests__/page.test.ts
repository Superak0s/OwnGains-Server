import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import request from "supertest"
import { app } from "../app.js"
import { marketplaceConfig } from "../env.js"
import { stubAuthServer, fakeUser, bearer } from "./authStub.js"

const author = fakeUser("pagewriter")
const admin = fakeUser("pageadmin", true)

const publish = async (name: string) =>
  (
    await request(app)
      .post("/api/skins")
      .set(bearer(author))
      .send({ name, skin: { format: 1, theme: { name: "T", colors: { accent: "#10b981" } } } })
  ).body.id as number

beforeEach(() => {
  stubAuthServer([author, admin])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("skin page", () => {
  it("escapes user text", async () => {
    const id = await publish("<script>alert(1)</script>")
    const res = await request(app).get(`/skins/${id}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(res.text).not.toContain("<script>alert")
  })

  it("offers a report link that needs no account, only when an address is set", async () => {
    const id = await publish("Reportable")
    expect((await request(app).get(`/skins/${id}`)).text).not.toContain("mailto:")
    marketplaceConfig.reportEmail = "abuse@market.test"
    try {
      expect((await request(app).get(`/skins/${id}`)).text).toContain(
        `mailto:abuse@market.test?subject=${encodeURIComponent(`Report skin ${id}`)}`,
      )
    } finally {
      marketplaceConfig.reportEmail = ""
    }
  })

  it("links to the app with the marketplace address", async () => {
    const id = await publish("Linked")
    const res = await request(app).get(`/skins/${id}`)
    expect(res.text).toContain(`owngains://skin/${id}?m=${encodeURIComponent("https://market.test/marketplace")}`)
    expect(res.text).toContain("https://play.google.com/store/apps/details?id=com.owngains.app")
  })

  it("sends a strict CSP whose nonce matches the one script", async () => {
    const id = await publish("Csp")
    const res = await request(app).get(`/skins/${id}`)
    const csp = res.headers["content-security-policy"]
    expect(csp).toContain("default-src 'none'")
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]
    expect(res.text).toContain(`<script nonce="${nonce}">`)
  })

  it("404s a taken-down skin", async () => {
    const id = await publish("Gone")
    await request(app).delete(`/api/skins/${id}`).set(bearer(admin)).send({ reason: "Spam" })
    const res = await request(app).get(`/skins/${id}`)
    expect(res.status).toBe(404)
    expect(res.headers["content-type"]).toContain("text/html")
  })
})
