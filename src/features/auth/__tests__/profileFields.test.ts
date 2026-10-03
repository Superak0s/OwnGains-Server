import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

// heightCm and bfFormulaSex were write-only: PUT /profile stored them but no
// user object carried them back, so a new device lost both.
describe("height and body-fat formula on the user object", () => {
  it("is null until set, then comes back on every auth route", async () => {
    const u = await signup("prof")
    expect(u.user.heightCm).toBeNull()
    // Not defaulted to "male": the app must be able to tell unset from a choice.
    expect(u.user.bfFormulaSex).toBeNull()

    const put = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({ heightCm: 182, bfFormulaSex: "female" })
    expect(put.status).toBe(200)
    expect(put.body.user).toMatchObject({ heightCm: 182, bfFormulaSex: "female" })

    const me = await request(app).get("/api/auth/me").set(auth(u.token))
    expect(me.body.user).toMatchObject({ heightCm: 182, bfFormulaSex: "female" })

    const signin = await request(app)
      .post("/api/auth/signin")
      .send({ username: u.username, password: u.password })
    expect(signin.body.user).toMatchObject({ heightCm: 182, bfFormulaSex: "female" })

    // The no-op PUT answers from req.user, so authenticateToken's lookup must
    // carry the fields too.
    const noop = await request(app).put("/api/auth/profile").set(auth(u.token)).send({})
    expect(noop.body.user).toMatchObject({ heightCm: 182, bfFormulaSex: "female" })
  })
})
