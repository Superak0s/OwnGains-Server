import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import request from "supertest"

// The "ID token" is the JSON payload itself. The mock enforces the audience the
// way Google's verifier does.
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    async verifyIdToken({ idToken, audience }: { idToken: string; audience: string }) {
      const payload = JSON.parse(idToken)
      if (payload.aud !== audience) throw new Error("Wrong recipient")
      return { getPayload: () => payload }
    }
  },
}))

const { app, auth, uniqueName } = await import("../../../tests/helpers.js")
const { pool } = await import("@/config/database.js")

const CLIENT_ID = "test-client.apps.googleusercontent.com"

function token(over: Record<string, unknown> = {}) {
  const sub = uniqueName("sub")
  return JSON.stringify({
    aud: CLIENT_ID,
    sub,
    email: `${sub}@gmail.test`,
    email_verified: true,
    name: "Goog User",
    ...over,
  })
}

const google = (idToken: string, extra: Record<string, unknown> = {}) =>
  request(app).post("/api/auth/google").send({ idToken, termsVersion: "test", healthConsent: true, ...extra })

describe("POST /api/auth/google", () => {
  beforeEach(() => {
    process.env.GOOGLE_WEB_CLIENT_ID = CLIENT_ID
  })
  afterEach(() => {
    delete process.env.GOOGLE_WEB_CLIENT_ID
  })

  it("creates a new user with no password and recorded Terms", async () => {
    const res = await google(token())
    expect(res.status).toBe(201)
    expect(res.body.token).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
    expect(res.body.user.hasPassword).toBe(false)
    expect(res.body.user.termsVersion).toBe("test")
    expect(res.body.user.username).toMatch(/^[A-Za-z0-9_]{3,20}$/)
  })

  it("signs in an existing sub", async () => {
    const t = token()
    const first = await google(t)
    const again = await google(t)
    expect(again.status).toBe(200)
    expect(again.body.user.id).toBe(first.body.user.id)
  })

  it("gives a second account with the same email local part a suffixed username", async () => {
    const local = uniqueName("same")
    const a = await google(token({ email: `${local}@a.test` }))
    const b = await google(token({ email: `${local}@b.test` }))
    expect(b.status).toBe(201)
    expect(b.body.user.username).not.toBe(a.body.user.username)
  })

  async function passwordAccount() {
    const username = uniqueName("link")
    const email = `${username}@test.local`
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ username, email, password: "Passw0rd-123", termsVersion: "test" })
    return { username, email, signup }
  }

  it("asks for the password before linking an existing account by email", async () => {
    const { username, email } = await passwordAccount()
    const res = await google(token({ email }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("GOOGLE_LINK_NEEDS_PASSWORD")
    expect(res.body.details).toEqual({ username })
  })

  it("refuses to link with the wrong password", async () => {
    const { email } = await passwordAccount()
    const t = token({ email })
    const res = await google(t, { password: "Wr0ng-password" })
    expect(res.status).toBe(401)
    const [rows] = await pool.execute("SELECT google_sub FROM users WHERE email = ?", [email])
    expect((rows as { google_sub: string | null }[])[0].google_sub).toBeNull()
  })

  it("links an existing password account with its password", async () => {
    const { email, signup } = await passwordAccount()
    const t = token({ email })
    const res = await google(t, { password: "Passw0rd-123" })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(signup.body.user.id)
    expect(res.body.user.hasPassword).toBe(true)
    expect(res.body.user.googleLinked).toBe(true)
    const again = await google(t)
    expect(again.status).toBe(200)
  })

  it("unlinks Google after checking the password", async () => {
    const { email, signup } = await passwordAccount()
    const t = token({ email })
    await google(t, { password: "Passw0rd-123" })
    const wrong = await request(app)
      .delete("/api/auth/google")
      .set(auth(signup.body.token))
      .send({ password: "Wr0ng-password" })
    expect(wrong.status).toBe(403)
    const ok = await request(app)
      .delete("/api/auth/google")
      .set(auth(signup.body.token))
      .send({ password: "Passw0rd-123" })
    expect(ok.status).toBe(200)
    expect(ok.body.user.googleLinked).toBe(false)
    const relink = await google(t)
    expect(relink.body.code).toBe("GOOGLE_LINK_NEEDS_PASSWORD")
  })

  it("refuses to unlink a Google-only account", async () => {
    const created = await google(token())
    expect(created.body.user.googleLinked).toBe(true)
    const res = await request(app)
      .delete("/api/auth/google")
      .set(auth(created.body.token))
      .send({ password: "anything" })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe("NO_PASSWORD")
  })

  it("rejects an unverified email", async () => {
    const res = await google(token({ email_verified: false }))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe("GOOGLE_EMAIL_UNVERIFIED")
  })

  it("rejects a token for another audience", async () => {
    const res = await google(token({ aud: "someone-else" }))
    expect(res.status).toBe(401)
  })

  it("rejects a missing token", async () => {
    const res = await request(app).post("/api/auth/google").send({})
    expect(res.status).toBe(400)
  })

  it("rejects a suspended user", async () => {
    const t = token()
    const created = await google(t)
    await pool.execute("UPDATE users SET disabled_at = NOW() WHERE uuid = ?", [created.body.user.id])
    const res = await google(t)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe("ACCOUNT_DISABLED")
  })

  it("never lets password signin into a Google-created account", async () => {
    const created = await google(token())
    const res = await request(app)
      .post("/api/auth/signin")
      .send({ username: created.body.user.username, password: "Passw0rd-123" })
    expect(res.status).toBe(401)
  })

  it("refuses a password change for a Google-only account", async () => {
    const created = await google(token())
    const res = await request(app)
      .put("/api/auth/password")
      .set(auth(created.body.token))
      .send({ currentPassword: "Passw0rd-123", newPassword: "Passw0rd-456" })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe("NO_PASSWORD")
  })

  it("deletes the account with a fresh idToken, and refuses another Google account's", async () => {
    const t = token()
    const created = await google(t)
    const wrong = await request(app)
      .delete("/api/auth/account")
      .set(auth(created.body.token))
      .send({ idToken: token() })
    expect(wrong.status).toBe(403)

    const ok = await request(app)
      .delete("/api/auth/account")
      .set(auth(created.body.token))
      .send({ idToken: t })
    expect(ok.status).toBe(200)
    const [rows] = await pool.execute("SELECT 1 FROM users WHERE uuid = ?", [created.body.user.id])
    expect(rows).toHaveLength(0)
  })

  it("includes the Google account ID in the data export", async () => {
    const t = token()
    const created = await google(t)
    const res = await request(app).get("/api/auth/account/export").set(auth(created.body.token))
    expect(res.body.data.profile.google_sub).toBe(JSON.parse(t).sub)
  })

  it("answers 404 when GOOGLE_WEB_CLIENT_ID is unset", async () => {
    delete process.env.GOOGLE_WEB_CLIENT_ID
    const res = await google(token())
    expect(res.status).toBe(404)
  })
})
