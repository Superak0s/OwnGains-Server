import { describe, it, expect } from "vitest"
import type { Request } from "express"
import { localDay, requestTimeZone } from "../timeZone.js"

describe("localDay", () => {
  it("is the calendar day in the given zone", () => {
    expect(localDay(new Date("2026-10-22T22:30:00Z"), "Europe/Athens")).toBe("2026-10-23")
    expect(localDay(new Date("2026-10-22T22:30:00Z"), "UTC")).toBe("2026-10-22")
    expect(localDay(new Date("2026-10-25T21:30:00Z"), "Europe/Athens")).toBe("2026-10-25")
    expect(localDay(new Date("2026-10-23T06:30:00Z"), "America/Los_Angeles")).toBe("2026-10-22")
  })
})

describe("requestTimeZone", () => {
  const req = (zone?: string) => ({ get: () => zone }) as unknown as Request

  it("accepts a known zone and falls back to UTC otherwise", () => {
    expect(requestTimeZone(req("Europe/Athens"))).toBe("Europe/Athens")
    expect(requestTimeZone(req("Mars/Base"))).toBe("UTC")
    expect(requestTimeZone(req(undefined))).toBe("UTC")
  })
})
