// server.ts boot checks, start() and shutdown(), run in-process: v8 coverage
// can't see the child process server.boot.test.ts spawns. Each case re-imports
// server.ts with its own env. process.exit is stubbed and mDNS is faked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import os from "node:os"
import request from "supertest"

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  publish: vi.fn(),
  destroy: vi.fn(),
  wsFailOnce: false,
}))

vi.mock("bonjour-service", () => ({
  Bonjour: class {
    publish = mocks.publish.mockImplementation(() => ({ stop: mocks.stop }))
    destroy = mocks.destroy
  },
}))
// The real sweep would end every stale workout in the shared test database
// under the global cleanup lock, racing the suites that own those rows.
vi.mock("../jobs/sessionCleanup.js", () => ({
  startStaleSessionCleanup: vi.fn(),
  stopStaleSessionCleanup: vi.fn(async () => {}),
}))
vi.mock("../ws/wsServer.js", async (orig) => {
  const m = await orig<typeof import("../ws/wsServer.js")>()
  return {
    ...m,
    createWsServer: (...a: Parameters<typeof m.createWsServer>) => {
      if (mocks.wsFailOnce) {
        mocks.wsFailOnce = false
        throw new Error("ws failed")
      }
      return m.createWsServer(...a)
    },
  }
})

type Server = typeof import("../server.js")
const saved = { ...process.env }
const events = ["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException"] as const
let exit: ReturnType<typeof vi.spyOn>
let timers: ReturnType<typeof vi.spyOn>
let log: { info: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> }
let pools: { end(): Promise<void> }[] = []

async function boot(env: Record<string, string | undefined> = {}): Promise<Server> {
  vi.resetModules()
  process.env = { ...saved }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const srv = await import("../server.js")
  pools.push((await import("../config/database.js")).pool)
  return srv
}

const logged = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c: unknown[]) => c.slice(1).join(" ")).join("\n")
// Typed as signals only, though process emits these events too.
const listeners = (e: string) => process.listeners(e as NodeJS.Signals) as ((...a: unknown[]) => void)[]
const listener = (e: (typeof events)[number]) => listeners(e).at(-1)!

beforeEach(() => {
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
  // shutdown()'s 5s exit backstop is recorded, never armed: on a loaded box it
  // could fire first, pass the test early, and leave the real close callback
  // to call process.exit after the stub is gone.
  const realTimeout = globalThis.setTimeout
  timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    realTimeout(ms === 5000 ? () => {} : fn, ms === 5000 ? 0 : ms)) as typeof setTimeout)
  log = {
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  process.env = { ...saved }
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => {})))
})

describe("server boot checks", () => {
  it.each([
    [{ JWT_SECRET: undefined }, "JWT_SECRET env var is not set"],
    [{ JWT_SECRET: "short" }, "JWT_SECRET is too weak"],
    [{ ALLOWED_ORIGINS: undefined }, "ALLOWED_ORIGINS env var is not set"],
    [{ ALLOWED_ORIGINS: " , " }, "ALLOWED_ORIGINS env var is not set"],
    [{ ALLOWED_ORIGINS: "*,http://localhost:3000" }, 'does not support "*"'],
  ])("%o refuses to boot", async (env, message) => {
    await expect(boot(env)).rejects.toThrow(message)
  })
})

describe("RATE_LIMIT_BYPASS_LOCAL_IPS", () => {
  beforeEach(() => {
    delete saved.VITEST
  })
  afterEach(() => {
    saved.VITEST = "true"
  })

  it("warns when it can't tell a proxy from a local client, and skips local callers", async () => {
    const { app } = await boot({ RATE_LIMIT_BYPASS_LOCAL_IPS: "true", TRUST_PROXY_HOPS: "0", PORT: undefined })
    expect(logged(log.warn)).toContain("RATE_LIMIT_BYPASS_LOCAL_IPS=true with TRUST_PROXY_HOPS=0")
    const res = await request(app).get("/api/version")
    expect(res.headers["ratelimit-limit"]).toBeUndefined()
  })

  it("skips private ranges only, read from X-Forwarded-For behind a proxy", async () => {
    const { app } = await boot({ RATE_LIMIT_BYPASS_LOCAL_IPS: "true", TRUST_PROXY_HOPS: "1" })
    const from = (ip: string) => request(app).get("/api/version").set("X-Forwarded-For", ip)
    expect((await from("172.20.0.1")).headers["ratelimit-limit"]).toBeUndefined()
    expect((await from("8.8.8.8")).headers["ratelimit-limit"]).toBe("200")
  })

  it("keys the demo-fill limiter by account", async () => {
    const { app } = await boot()
    const username = `lim_${Math.random().toString(36).slice(2, 10)}`
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ username, email: `${username}@test.local`, password: "Passw0rd-123", termsVersion: "test", healthConsent: true })
    const res = await request(app).post("/api/sessions/demo").set("Authorization", `Bearer ${signup.body.token}`)
    expect(res.headers["ratelimit-limit"]).toBe("5")
  })
})

describe("server lifecycle", () => {
  it("/healthz answers DOWN when the database probe fails", async () => {
    const { app } = await boot()
    const { pool } = await import("../config/database.js")
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("gone"))
    const res = await request(app).get("/healthz")
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: "DOWN" })
  })

  it("picks a physical LAN NIC for mDNS", async () => {
    const { getLanInterface } = await boot()
    const v4 = (address: string, internal = false) => ({ family: "IPv4", internal, address }) as os.NetworkInterfaceInfo
    vi.spyOn(os, "networkInterfaces").mockReturnValueOnce({
      "vEthernet (WSL)": [v4("172.20.0.1")],
      lo: [v4("127.0.0.1", true)],
      gone: undefined,
      "Wi-Fi": [{ ...v4("fe80::1"), family: "IPv6", scopeid: 0 }, v4("192.168.1.9")],
    })
    expect(getLanInterface()).toBe("192.168.1.9")
    vi.spyOn(os, "networkInterfaces").mockReturnValueOnce({})
    expect(getLanInterface()).toBeUndefined()
  })

  it("starts, advertises over mDNS, handles process events and shuts down once", async () => {
    const before = Object.fromEntries(events.map((e) => [e, listeners(e).length]))
    const srv = await boot({ PORT: "0", MDNS_ENABLED: "true", SERVER_FQDN: "gains.example" })
    const { pool } = await import("../config/database.js")
    try {
      // A failed start is logged and exits 1.
      mocks.wsFailOnce = true
      srv.main()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), 10_000)
      expect(logged(log.error)).toContain("Failed to start server:")

      exit.mockClear()
      await srv.start()
      await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalled())
      expect(mocks.publish.mock.calls[0]![0]).toMatchObject({ txt: { fqdn: "gains.example" } })
      expect(logged(log.info)).toContain("(fqdn: gains.example)")

      const reject = listener("unhandledRejection")
      reject(new Error("with stack"))
      reject(Object.assign(new Error("no stack"), { stack: undefined }))
      reject("a string")
      expect(logged(log.error)).toMatch(/Error: with stack[\s\S]*no stack[\s\S]*a string/)

      vi.spyOn(pool, "end").mockRejectedValueOnce(new Error("pool stuck"))

      listener("SIGTERM")()
      expect((await request(srv.app).get("/healthz")).body).toEqual({ status: "DRAINING" })
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), 10_000)
      expect(logged(log.error)).toContain("Error closing DB pool:")
      expect(mocks.stop).toHaveBeenCalled()
      expect(mocks.destroy).toHaveBeenCalled()

      // A second signal or a crash mid-shutdown does nothing more.
      exit.mockClear()
      listener("SIGINT")()
      listener("uncaughtException")(new Error("late"))
      expect(logged(log.error)).toContain("Uncaught exception:")

      // The backstop timer forces the exit if a connection won't close.
      const backstop = timers.mock.calls.find((c: unknown[]) => c[1] === 5000)![0] as () => void
      backstop()
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      for (const e of events) for (const l of listeners(e).slice(before[e])) process.off(e as NodeJS.Signals, l)
    }
  })

  it.each([
    ["false", "mDNS advertising disabled"],
    ["true", "Advertising via mDNS as _owngains._tcp\n"],
  ])("runs without SERVER_FQDN, MDNS_ENABLED=%s", async (mdns, line) => {
    mocks.publish.mockClear()
    const srv = await boot({ PORT: "0", MDNS_ENABLED: mdns, SERVER_FQDN: undefined })
    await srv.start()
    await vi.waitFor(() => expect(logged(log.info) + "\n").toContain(line))
    srv.shutdown(0)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), 10_000)
    expect(mocks.publish).toHaveBeenCalledTimes(mdns === "true" ? 1 : 0)
  })
})
