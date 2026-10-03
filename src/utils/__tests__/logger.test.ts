import { describe, it, expect, vi, afterEach } from "vitest"
import { logger } from "../logger.js"

afterEach(() => vi.restoreAllMocks())

describe("logger", () => {
  it("prefixes console calls with a timestamp and level", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    logger.info("hello", { a: 1 })
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T.*\] INFO$/), "hello", { a: 1 })

    logger.warn("careful")
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[.*\] WARN$/), "careful")

    logger.error("bad")
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[.*\] ERROR$/), "bad")
  })
})
