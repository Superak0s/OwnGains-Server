import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup } from "../../../tests/helpers.js"
import { findUserByCredentials } from "../auth.model.js"
import { assertNotThrottled, recordFailure, ThrottledError } from "../throttle.model.js"

// The signin throttle must share one bucket across every spelling the account
// lookup treats as the same name, or each spelling is a fresh set of guesses.
const variants = (name: string) => [
  "á" + name.slice(1),
  "Á" + name.slice(1).toUpperCase(),
  "ａ" + name.slice(1), // full-width a
  name.slice(0, 3) + "­" + name.slice(3), // soft hyphen
  ` ${name} `,
  name.toUpperCase(),
]

describe("signin throttle and collation", () => {
  it("puts every spelling the lookup resolves to the account in one bucket", async () => {
    const a = await signup("alice")
    const id = (await findUserByCredentials(a.username))!.id
    const matching: string[] = []
    for (const v of variants(a.username))
      if ((await findUserByCredentials(v.trim()))?.id === id) matching.push(v)
    // Accents and case fold on every supported collation.
    expect(matching).toContain("á" + a.username.slice(1))

    for (let i = 0; i < 6; i++) await recordFailure("signin", a.username)
    for (const v of matching)
      await expect(assertNotThrottled("signin", v), v).rejects.toBeInstanceOf(ThrottledError)
  })

  it("locks an accented spelling after misses on the plain one", async () => {
    const a = await signup("alice")
    for (let i = 0; i < 6; i++)
      await request(app).post("/api/auth/signin").send({ username: a.username, password: "WrongPass12" })
    const res = await request(app)
      .post("/api/auth/signin")
      .send({ username: "á" + a.username.slice(1), password: a.password })
    expect(res.status).toBe(429)
    expect(res.body.code).toBe("AUTH_THROTTLED")
  })

  it("locks an unknown name's spellings the same way", async () => {
    for (let i = 0; i < 6; i++) await recordFailure("signin", "ghost_coll")
    await expect(assertNotThrottled("signin", "GHÓST_coll")).rejects.toBeInstanceOf(ThrottledError)
  })
})
