import { describe, it, expect, vi, afterEach } from "vitest"
import { logger } from "../logger.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("logger", () => {
  it("prefixes console calls with a timestamp and level", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    logger.info("hello", { a: 1 })
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T.*\] INFO$/), "hello", { a: 1 })

    logger.warn("careful")
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[.*\] WARN$/), "careful")

    logger.error("bad")
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[.*\] ERROR$/), "bad")

    // info is the default, so request lines stay out of the log.
    logger.debug("GET /api/x 200")
    expect(debug).not.toHaveBeenCalled()
  })

  it("prints debug lines at LOG_LEVEL=debug", async () => {
    vi.stubEnv("LOG_LEVEL", "debug")
    vi.resetModules()
    const { logger: chatty, logLevel } = await import("../logger.js")
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})

    chatty.debug("GET /api/x 200")
    expect(logLevel).toBe("debug")
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[.*\] DEBUG$/), "GET /api/x 200")
  })

  it("drops levels below LOG_LEVEL", async () => {
    vi.stubEnv("LOG_LEVEL", "warn")
    vi.resetModules()
    const { logger: quiet } = await import("../logger.js")
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    quiet.info("noise")
    quiet.warn("careful")
    expect(info).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it("colors the level only when colors are forced", async () => {
    vi.stubEnv("FORCE_COLOR", "1")
    const { paint } = await import("../logger.js")
    expect(paint("red", "x")).toBe("\u001b[31mx\u001b[39m")
  })

  it("refuses an unknown LOG_LEVEL", async () => {
    vi.stubEnv("LOG_LEVEL", "verbose")
    vi.resetModules()
    await expect(import("../logger.js")).rejects.toThrow(/LOG_LEVEL/)
  })
})
