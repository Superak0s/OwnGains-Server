import { describe, it, expect } from "vitest"
import {
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
  BCRYPT_COST,
} from "../password.js"
import { lockSecondsFor } from "../throttle.model.js"

describe("password hashing", () => {
  it("still verifies $2a$ hashes written by bcryptjs", async () => {
    const legacy = "$2a$04$WA2c3ZgByeGX1KE0MrxHPeDxPl6EeGlx4lmOnXsdLiKJk9mbwymz."
    expect(await verifyPassword("Legacy-pass-1", legacy)).toBe(true)
    expect(await verifyPassword("Legacy-pass-2", legacy)).toBe(false)
  })

  it("hashes at the configured cost and round-trips", async () => {
    const h = await hashPassword("Round-trip-1")
    expect(h.startsWith(`$2b$${BCRYPT_COST}$`)).toBe(true)
    expect(await verifyPassword("Round-trip-1", h)).toBe(true)
  })

  it("uses a constant dummy hash at the same cost as real ones", async () => {
    expect(DUMMY_PASSWORD_HASH.startsWith(`$2b$${BCRYPT_COST}$`)).toBe(true)
    expect(await verifyPassword("anything", DUMMY_PASSWORD_HASH)).toBe(false)
  })

  it("queues concurrent hashes behind the semaphore instead of failing them", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => hashPassword(`Concurrent-${i}`)),
    )
    expect(new Set(results).size).toBe(6)
  })
})

describe("signin backoff schedule", () => {
  it("is free for 5 misses, then doubles from 30s up to 15 minutes", () => {
    expect(lockSecondsFor(5)).toBe(0)
    expect(lockSecondsFor(6)).toBe(30)
    expect(lockSecondsFor(7)).toBe(60)
    expect(lockSecondsFor(10)).toBe(480)
    expect(lockSecondsFor(50)).toBe(900)
  })
})
