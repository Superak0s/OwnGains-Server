// Model lookups and writes for users that don't exist, or inputs the routes
// never send: missing users, empty consent, refresh revocation modes, and
// deleting an account that used exercises.
import { describe, it, expect, afterEach, vi } from "vitest"
import jwt from "jsonwebtoken"
import { signup, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import * as a from "../auth.model.js"
import { createSession, recordSetTiming } from "../../workouts/workouts.model.js"

afterEach(() => vi.unstubAllEnvs())

describe("auth model edges", () => {
  it("finds nothing for a user that doesn't exist", async () => {
    expect(await a.findUserById(999_999_999)).toBeNull()
    expect(await a.findUserByUuid(crypto.randomUUID())).toBeNull()
    expect(await a.getPasswordHash(999_999_999)).toBeNull()
    expect(await a.getTokenVersion(999_999_999)).toBe(0)
  })

  it("passes through errors that aren't a duplicate key", () => {
    const err = new Error("other")
    expect(a.asDuplicateUserError(err)).toBe(err)
    expect(a.asDuplicateUserError({ errno: 1062 })).toMatchObject({ code: "ACCOUNT_UNAVAILABLE" })
  })

  it("records nothing for empty consent, and terms alone", async () => {
    const id = await internalId((await signup("aconsent")).user.id)
    await a.recordConsent(id, {})
    await a.recordConsent(id, { termsVersion: "9" })
    const [[row]] = await pool.query<never[]>(`SELECT terms_version FROM users WHERE id = ?`, [id])
    expect(row["terms_version"]).toBe("9")
  })

  it("signs tokens with the configured lifetime", () => {
    vi.stubEnv("JWT_EXPIRES_IN", "1h")
    const { exp, iat } = jwt.decode(a.generateToken("u", 0)) as { exp: number; iat: number }
    expect(exp - iat).toBe(3600)
  })

  it("revokes every refresh token, or none when given nothing", async () => {
    const id = await internalId((await signup("arefresh")).user.id)
    const token = await a.issueRefreshToken(id)
    await a.revokeRefreshTokens(id, {})
    expect((await a.rotateRefreshToken(token)).ok).toBe(true)
    await a.revokeRefreshTokens(id, { allDevices: true })
    const [[open]] = await pool.query<never[]>(
      `SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL`,
      [id],
    )
    expect(Number(open["n"])).toBe(0)
  })

  it("sweeps the custom exercises a deleted account used", async () => {
    const id = await internalId((await signup("adel")).user.id)
    const name = `DelOnly${Date.now()}`
    const w = await createSession(id, 1, "D", "2026-01-01T09:00:00Z")
    await recordSetTiming(w, id, { exerciseName: name, setIndex: 0, startTime: "2026-01-01T10:00:00Z", endTime: "2026-01-01T10:01:00Z", weight: 1, reps: 1 })
    await a.deleteUser(id)
    const [rows] = await pool.query<never[]>(`SELECT id FROM exercises WHERE name = ?`, [name])
    expect(rows).toHaveLength(0)
  })
})
