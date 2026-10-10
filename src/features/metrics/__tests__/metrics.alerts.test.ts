import { describe, it, expect, vi, afterEach } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function load(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  return import("../metrics.alerts.js")
}

describe("Telegram bot alerts", () => {
  it("are off without a token and chat id", async () => {
    const a = await load({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" })
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (let i = 0; i < 100; i++) a.noteSuspicious("9.9.9.9", 404, "/wp-login.php")
    await a.checkBotTraffic()
    expect(a.botAlertsEnabled).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("report an IP over the threshold once per cooldown, and keep the token out of the log", async () => {
    const a = await load({ TELEGRAM_BOT_TOKEN: "tok123", TELEGRAM_CHAT_ID: "42", BOT_ALERT_THRESHOLD: "3" })
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetch)
    expect(a.isSuspicious(404, false)).toBe(true)
    expect(a.isSuspicious(404, true)).toBe(false)
    for (let i = 0; i < 3; i++) a.noteSuspicious("9.9.9.9", 401, "/api/auth/signin")
    a.noteSuspicious("1.1.1.1", 404, "/x")
    await a.checkBotTraffic(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.chat_id).toBe("42")
    expect(body.text).toContain("9.9.9.9: 3 (401×3), top path /api/auth/signin")
    expect(body.text).not.toContain("1.1.1.1")

    for (let i = 0; i < 3; i++) a.noteSuspicious("9.9.9.9", 401, "/a")
    await a.checkBotTraffic(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockRejectedValue(new Error("fetch https://api.telegram.org/bottok123/sendMessage failed"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (let i = 0; i < 3; i++) a.noteSuspicious("9.9.9.9", 401, "/a")
    await a.checkBotTraffic(3_600_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warn.mock.calls)).not.toContain("tok123")
  })

  it("send one health message on crossing a limit and one on recovery", async () => {
    const a = await load({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", ALERT_P99_MS: "0", ALERT_ERROR_RATE_PCT: "0.5" })
    expect(a.healthLimits).toMatchObject({ p95Ms: 500, p99Ms: 0, errorRatePct: 0.5, minRequests: 30 })
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetch)
    const text = (i: number) => JSON.parse(fetch.mock.calls[i][1].body).text as string

    // Too few requests to judge, and p99 is off.
    await a.checkHealth({ requests: 10, serverErrors: 10, p95Ms: 9000, p99Ms: 9000 })
    expect(fetch).not.toHaveBeenCalled()

    await a.checkHealth({ requests: 200, serverErrors: 1, p95Ms: 500, p99Ms: 9000 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(text(0)).toContain("Over: p95 latency 500ms (limit 500ms)")
    expect(text(0)).toContain("Over: 5xx rate 0.5% (limit 0.5%)")
    expect(text(0)).not.toContain("p99")

    // Still over: nothing new.
    await a.checkHealth({ requests: 200, serverErrors: 2, p95Ms: 800, p99Ms: 9000 })
    expect(fetch).toHaveBeenCalledTimes(1)

    await a.checkHealth({ requests: 200, serverErrors: 0, p95Ms: 120, p99Ms: 9000 })
    expect(text(1)).toContain("Back under: p95 latency 120ms")
    expect(text(1)).toContain("Back under: 5xx rate 0%")
  })

  it("refuse a malformed limit at load", async () => {
    await expect(load({ ALERT_ERROR_RATE_PCT: "1%" })).rejects.toThrow(/ALERT_ERROR_RATE_PCT/)
  })
})
