import { describe, it, expect, vi } from "vitest"
import type { Request } from "express"
import jwt from "jsonwebtoken"
import { randomUUID } from "node:crypto"
import { authenticateToken } from "../auth.js"
import { signup, auth } from "../../tests/helpers.js"

async function run(token?: string) {
  const next = vi.fn()
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as Request
  await authenticateToken(req, ({} as unknown) as never, next as never)
  return { next, req }
}

describe("authenticateToken", () => {
  it("rejects a missing token", async () => {
    const { next } = await run()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Access token required" }))
  })

  it("rejects a malformed header", async () => {
    const next = vi.fn()
    const req = { headers: { authorization: "Bearer" } } as Request
    await authenticateToken(req, ({} as unknown) as never, next as never)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Access token required" }))
  })

  it("rejects an invalid signature", async () => {
    const { next } = await run("garbage.token.here")
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Invalid or expired token" }))
  })

  it("rejects a token for a deleted user", async () => {
    const token = jwt.sign({ userId: randomUUID(), tokenVersion: 0 }, process.env.JWT_SECRET!, {
      algorithm: "HS256",
    })
    const { next } = await run(token)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "User not found" }))
  })

  // Pre-migration tokens contain the numeric users.id. MySQL would coerce a
  // uuid column compared against a number, so these must never reach the lookup.
  it("rejects a legacy numeric-id token", async () => {
    const token = jwt.sign({ userId: 1, tokenVersion: 0 }, process.env.JWT_SECRET!, {
      algorithm: "HS256",
    })
    const { next } = await run(token)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Invalid or expired token" }))
  })

  it("rejects a revoked token (token version mismatch)", async () => {
    const u = await signup("rev")
    const token = jwt.sign({ userId: u.user.id, tokenVersion: 999 }, process.env.JWT_SECRET!, {
      algorithm: "HS256",
    })
    const { next } = await run(token)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Token has been revoked" }))
  })

  it("attaches req.user for a valid token", async () => {
    const u = await signup("ok")
    const { next, req } = await run(u.token)
    expect(next).toHaveBeenCalledWith()
    expect(req.user!.username).toBe(u.username)
  })
})
