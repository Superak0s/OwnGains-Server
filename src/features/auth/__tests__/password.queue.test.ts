// The hash queue's ceiling, with bcrypt stalled so every slot stays taken.
import { describe, it, expect, vi } from "vitest"

vi.mock("bcrypt", () => ({ default: { hash: () => new Promise(() => {}), compare: vi.fn() } }))

const { hashPassword } = await import("../password.js")

describe("password hash queue", () => {
  it("refuses with 429 once the queue is full", async () => {
    // 2 running plus 100 waiting, all stalled forever.
    for (let i = 0; i < 102; i++) void hashPassword("x")
    await expect(hashPassword("x")).rejects.toMatchObject({ statusCode: 429, code: "AUTH_BUSY" })
  })
})
