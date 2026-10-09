import { describe, it, expect, afterEach, vi } from "vitest"
import http from "node:http"
import jwt from "jsonwebtoken"
import WebSocket, { type WebSocketServer } from "ws"
import { closeWsServer, createWsServer, getWsStats, sendToUser, type WsServerOptions } from "../wsServer.js"
import { createUser, findUserById } from "../../features/auth/auth.model.js"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { pool } from "../../config/database.js"
import { uniqueName } from "../../tests/helpers.js"

// Hardening of the WebSocket server: malformed frames (B1), connection caps
// (H7), batched heartbeat revalidation (H8) and multi-device fan-out (M14).
// Each test gets its own server so options can differ per test.

interface Harness {
  port: number
  wss: WebSocketServer
  close: () => Promise<void>
}

const open: Harness[] = []
const sockets: WebSocket[] = []

async function startServer(options: WsServerOptions = {}): Promise<Harness> {
  const httpServer = http.createServer()
  const wss = createWsServer(httpServer, { trustProxyHops: 0, ...options })
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
  const port = (httpServer.address() as { port: number }).port
  const h: Harness = {
    port,
    wss,
    close: async () => {
      wss.clients.forEach((ws) => ws.terminate())
      wss.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
  open.push(h)
  return h
}

function connect(port: number, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
    ws.on("open", () => {
      sockets.push(ws)
      resolve(ws)
    })
    ws.on("unexpected-response", (_req, res) =>
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })),
    )
    ws.on("error", reject)
  })
}

type WsMessage = { type: string; [key: string]: unknown }

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs)
    ws.once("message", (raw) => {
      clearTimeout(t)
      resolve(JSON.parse(raw.toString()))
    })
  })
}

function waitForClose(ws: WebSocket, timeoutMs = 8000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs)
    ws.once("close", (code, reason) => {
      clearTimeout(t)
      resolve({ code, reason: reason.toString() })
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function makeUser(): Promise<{ userId: string; token: string }> {
  const id = await createUser(uniqueName("wsp"), `${uniqueName("wsp")}@test.local`, "Passw0rd-123")
  const userId = (await findUserById(id))!.uuid
  const token = jwt.sign({ userId, tokenVersion: 0 }, process.env.JWT_SECRET!, {
    algorithm: "HS256",
    expiresIn: "15m",
  })
  return { userId, token }
}

async function authed(port: number, token: string): Promise<WebSocket> {
  const ws = await connect(port)
  ws.send(JSON.stringify({ type: "auth", token }))
  expect((await nextMessage(ws)).type).toBe("auth_success")
  return ws
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  for (const h of open.splice(0)) await h.close()
  vi.restoreAllMocks()
})

describe("B1: non-object frames", () => {
  const frames = ["null", "[]", '"str"', "1", "true", '{"type":5}', "{}"]

  it.each(frames)("survives %s before auth and still authenticates", async (frame) => {
    const rejections: unknown[] = []
    const onRejection = (r: unknown) => rejections.push(r)
    process.on("unhandledRejection", onRejection)
    try {
      const { port } = await startServer()
      const u = await makeUser()
      const ws = await connect(port)
      ws.send(frame)
      ws.send(JSON.stringify({ type: "auth", token: u.token }))
      expect((await nextMessage(ws)).type).toBe("auth_success")
      expect(ws.readyState).toBe(WebSocket.OPEN)
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
    }
  })

  it.each(frames)("survives %s after auth and keeps serving the socket", async (frame) => {
    const { port } = await startServer()
    const u = await makeUser()
    const ws = await authed(port, u.token)
    ws.send(frame)
    ws.send(JSON.stringify({ type: "auth.refresh", token: u.token }))
    expect(await nextMessage(ws)).toEqual({ type: "auth.refreshed" })
  })

  it("counts malformed frames toward the pre-auth cap", async () => {
    const { port } = await startServer()
    const ws = await connect(port)
    for (let i = 0; i < 11; i++) ws.send("null")
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain("too many messages before auth")
  })

  it("ignores a non-integer jointSessionId instead of querying with it", async () => {
    const { port } = await startServer()
    const u = await makeUser()
    const ws = await authed(port, u.token)
    ws.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: { a: 1 }, progress: "x" }))
    ws.send(JSON.stringify({ type: "leave_joint_session", jointSessionId: "1" }))
    ws.send(JSON.stringify({ type: "auth.refresh", token: u.token }))
    // The first reply is the refresh: the two bad frames produced nothing.
    expect(await nextMessage(ws)).toEqual({ type: "auth.refreshed" })
  })
})

describe("H7: connection caps", () => {
  it("refuses a client past its per-IP cap with 429, and frees the slot on close", async () => {
    const { port } = await startServer({ maxConnectionsPerIp: 2 })
    const a = await connect(port)
    await connect(port)
    await expect(connect(port)).rejects.toMatchObject({ status: 429 })

    a.close()
    await waitForClose(a)
    await sleep(50) // server-side TCP close lands just after the client's
    await expect(connect(port)).resolves.toBeInstanceOf(WebSocket)
  })

  it("refuses everyone past the global cap with 503", async () => {
    const { port } = await startServer({ maxConnections: 2, maxConnectionsPerIp: 100 })
    await connect(port)
    await connect(port)
    await expect(connect(port)).rejects.toMatchObject({ status: 503 })
    // A second refusal inside 10s isn't logged again.
    await expect(connect(port)).rejects.toMatchObject({ status: 503 })
  })

  it("keys the per-IP cap on X-Forwarded-For only when a proxy hop is trusted", async () => {
    const proxied = await startServer({ maxConnectionsPerIp: 1, trustProxyHops: 1 })
    await connect(proxied.port, { "X-Forwarded-For": "203.0.113.1" })
    await expect(
      connect(proxied.port, { "X-Forwarded-For": "203.0.113.1" }),
    ).rejects.toMatchObject({ status: 429 })
    // A different client behind the same proxy has its own bucket.
    await expect(
      connect(proxied.port, { "X-Forwarded-For": "203.0.113.2" }),
    ).resolves.toBeInstanceOf(WebSocket)
    // No header at all: the socket address is the client.
    await expect(connect(proxied.port)).resolves.toBeInstanceOf(WebSocket)

    // Exposed directly, the header is caller-supplied and must not create buckets.
    const direct = await startServer({ maxConnectionsPerIp: 1, trustProxyHops: 0 })
    await connect(direct.port, { "X-Forwarded-For": "203.0.113.1" })
    await expect(
      connect(direct.port, { "X-Forwarded-For": "203.0.113.2" }),
    ).rejects.toMatchObject({ status: 429 })
  })

  it("closes a socket that doesn't authenticate within the auth window", async () => {
    const { port } = await startServer({ authTimeoutMs: 200 })
    const ws = await connect(port)
    const started = Date.now()
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe("H8: heartbeat revalidation", () => {
  it("closes revoked and deleted users with one batched query, and leaves the rest", async () => {
    const { port } = await startServer({ heartbeatMs: 300 })
    const keep = await makeUser()
    const revoked = await makeUser()
    const deleted = await makeUser()
    const wsKeep = await authed(port, keep.token)
    const wsRevoked = await authed(port, revoked.token)
    const wsDeleted = await authed(port, deleted.token)

    const querySpy = vi.spyOn(pool, "query")
    const executeSpy = vi.spyOn(pool, "execute")

    await pool.execute("UPDATE users SET token_version = token_version + 1 WHERE uuid = ?", [
      revoked.userId,
    ])
    await pool.execute("DELETE FROM users WHERE uuid = ?", [deleted.userId])

    const [r, d] = await Promise.all([waitForClose(wsRevoked), waitForClose(wsDeleted)])
    expect(r).toEqual({ code: 4001, reason: "Unauthorized: Token has been revoked" })
    expect(d.code).toBe(4001)
    expect(wsKeep.readyState).toBe(WebSocket.OPEN)

    // Revalidation goes through pool.query with an IN list, never one
    // per-socket execute of findUserForAuth.
    const sweeps = querySpy.mock.calls.filter(([sql]) =>
      String(sql).includes("WHERE uuid IN (?)"),
    )
    expect(sweeps.length).toBeGreaterThan(0)
    const perSocket = executeSpy.mock.calls.filter(([sql]) =>
      /^\s*SELECT[\s\S]*FROM users WHERE uuid = \?/.test(String(sql)),
    )
    expect(perSocket).toEqual([])
  })
})

describe("M14: several sockets per user", () => {
  it("fans events out to every socket of the user", async () => {
    const { port } = await startServer()
    const u = await makeUser()
    const a = await authed(port, u.token)
    const b = await authed(port, u.token)
    const got = Promise.all([nextMessage(a), nextMessage(b)])
    sendToUser(u.userId, "ping_test", { n: 1 })
    expect(await got).toEqual([
      { type: "ping_test", n: 1 },
      { type: "ping_test", n: 1 },
    ])
  })

  it("replaces the oldest socket past the per-user cap", async () => {
    const { port } = await startServer({ maxSocketsPerUser: 2 })
    const u = await makeUser()
    const first = await authed(port, u.token)
    const second = await authed(port, u.token)
    const closed = waitForClose(first)
    await authed(port, u.token)
    expect(await closed).toEqual({ code: 1000, reason: "Replaced by new connection" })
    expect(second.readyState).toBe(WebSocket.OPEN)
  })
})

describe("leave_joint_session", () => {
  it("ends the session and sends the partner both end events", async () => {
    const { port } = await startServer()
    const a = await makeUser()
    const b = await makeUser()
    const [[ra], [rb]] = await Promise.all(
      [a, b].map((u) => pool.execute<(RowDataPacket & { id: number })[]>("SELECT id FROM users WHERE uuid = ?", [u.userId])),
    )
    const [js] = await pool.execute<ResultSetHeader>("INSERT INTO joint_sessions (created_by) VALUES (?)", [ra[0]!.id])
    await pool.execute(
      "INSERT INTO joint_session_participants (joint_session_id, user_id) VALUES (?, ?), (?, ?)",
      [js.insertId, ra[0]!.id, js.insertId, rb[0]!.id],
    )

    const wsA = await authed(port, a.token)
    const wsB = await authed(port, b.token)
    const got: WsMessage[] = []
    const both = new Promise<void>((resolve) =>
      wsB.on("message", (raw) => {
        got.push(JSON.parse(raw.toString()))
        if (got.length === 2) resolve()
      }),
    )
    wsA.send(JSON.stringify({ type: "leave_joint_session", jointSessionId: js.insertId }))
    await both

    expect(got.map((m) => m.type).sort()).toEqual(["invite_status", "joint_session_ended"])
    expect(got.find((m) => m.type === "invite_status")?.status).toBe("session_ended")
    const [rows] = await pool.execute<(RowDataPacket & { status: string })[]>("SELECT status FROM joint_sessions WHERE id = ?", [js.insertId])
    expect(rows[0]!.status).toBe("ended")
  })
})

describe("edge paths", () => {
  const sign = (userId: string, opts: jwt.SignOptions = { expiresIn: "15m" }) =>
    jwt.sign({ userId, tokenVersion: 0 }, process.env.JWT_SECRET!, { algorithm: "HS256", ...opts })
  const idOf = async (uuid: string) =>
    (await pool.execute<(RowDataPacket & { id: number })[]>("SELECT id FROM users WHERE uuid = ?", [uuid]))[0][0]!.id
  async function jointSession(...uuids: string[]): Promise<number> {
    const ids = await Promise.all(uuids.map(idOf))
    const [js] = await pool.execute<ResultSetHeader>("INSERT INTO joint_sessions (created_by) VALUES (?)", [ids[0]])
    for (const id of ids)
      await pool.execute("INSERT INTO joint_session_participants (joint_session_id, user_id) VALUES (?, ?)", [js.insertId, id])
    return js.insertId
  }
  const sendAuth = async (port: number, token: string) => {
    const ws = await connect(port)
    ws.send(JSON.stringify({ type: "auth", token }))
    return waitForClose(ws)
  }

  it("refuses a token for a non-uuid or unknown user, and reports a DB failure as 4002", async () => {
    const { port } = await startServer()
    expect(await sendAuth(port, sign("42"))).toEqual({ code: 4001, reason: "Unauthorized: invalid token" })
    expect(await sendAuth(port, sign(crypto.randomUUID()))).toEqual({ code: 4001, reason: "Unauthorized: User not found" })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(pool, "execute").mockRejectedValueOnce(new Error("db down"))
    expect((await sendAuth(port, sign(crypto.randomUUID()))).code).toBe(4002)
    expect(err).toHaveBeenCalled()
  })

  it("ignores a second auth frame while the first is being checked", async () => {
    const { port } = await startServer()
    const u = await makeUser()
    const ws = await connect(port)
    const auth = JSON.stringify({ type: "auth", token: u.token })
    ws.send(auth)
    ws.send(auth)
    expect((await nextMessage(ws)).type).toBe("auth_success")
    await expect(nextMessage(ws, 300)).rejects.toThrow("timed out")
  })

  it("drops an auth that finishes after its socket closed", async () => {
    const { port, wss } = await startServer()
    const u = await makeUser()
    const real = pool.execute.bind(pool)
    vi.spyOn(pool, "execute").mockImplementationOnce(((...a: Parameters<typeof pool.execute>) => {
      wss.clients.forEach((c) => c.terminate())
      return real(...a)
    }) as typeof pool.execute)
    const before = getWsStats().authenticatedSockets
    const ws = await connect(port)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    await waitForClose(ws)
    await sleep(100)
    expect(getWsStats().authenticatedSockets).toBe(before)
  })

  it("auth.refresh reports a DB failure as 4002", async () => {
    const { port } = await startServer()
    const u = await makeUser()
    const ws = await authed(port, u.token)
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(pool, "execute").mockRejectedValueOnce(new Error("db down"))
    ws.send(JSON.stringify({ type: "auth.refresh", token: u.token }))
    expect(await waitForClose(ws)).toEqual({ code: 4002, reason: "Server error during auth" })
  })

  it("relays joint progress, and refuses outsiders and ended sessions", async () => {
    const { port } = await startServer()
    const [a, b, c] = await Promise.all([makeUser(), makeUser(), makeUser()])
    const id = await jointSession(a.userId, b.userId)
    const [wsA, wsB, wsC] = await Promise.all([a, b, c].map((u) => authed(port, u.token)))
    expect(getWsStats()).toMatchObject({ running: true })
    expect(getWsStats().authenticatedSockets).toBeGreaterThanOrEqual(3)

    const toB = nextMessage(wsB)
    wsA.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: id }))
    expect(await toB).toMatchObject({ type: "joint_progress", jointSessionId: id, progress: { fromUserId: a.userId, readyForNext: false } })

    const toC = nextMessage(wsC)
    wsC.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: id, progress: {} }))
    expect(await toC).toEqual({ type: "error", message: "Not a participant" })

    await pool.execute("UPDATE joint_sessions SET status = 'ended' WHERE id = ?", [id])
    const ended = nextMessage(wsA)
    wsA.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: id, progress: null }))
    expect(await ended).toEqual({ type: "joint_session_ended", jointSessionId: id })
  })

  it("ignores a leave for a session the user is not in, and a solo leave notifies nobody", async () => {
    const { port } = await startServer()
    const u = await makeUser()
    const ws = await authed(port, u.token)
    const solo = await jointSession(u.userId)
    ws.send(JSON.stringify({ type: "leave_joint_session", jointSessionId: 2_000_000_000 }))
    ws.send(JSON.stringify({ type: "leave_joint_session", jointSessionId: solo }))
    await vi.waitFor(async () => {
      const [rows] = await pool.execute<(RowDataPacket & { status: string })[]>("SELECT status FROM joint_sessions WHERE id = ?", [solo])
      expect(rows[0]!.status).toBe("ended")
    })
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it.each([
    ["push_joint_progress", "a driver error is masked", new Error("ER_secret_detail"), "Server error"],
    ["push_joint_progress", "a 4xx is passed on", Object.assign(new Error("Conflict here"), { statusCode: 409 }), "Conflict here"],
    ["leave_joint_session", "a driver error is masked", new Error("ER_secret_detail"), "Server error"],
  ])("%s failure: %s", async (type, _name, error, message) => {
    const { port } = await startServer()
    const u = await makeUser()
    const ws = await authed(port, u.token)
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(pool, "execute").mockRejectedValueOnce(error)
    const reply = nextMessage(ws)
    ws.send(JSON.stringify({ type, jointSessionId: 1 }))
    expect(await reply).toEqual({ type: "error", message })
  })

  it("reports no connections once stopped", async () => {
    await startServer()
    closeWsServer()
    expect(getWsStats()).toMatchObject({ running: false, connections: 0, maxConnections: null, distinctIps: 0 })
  })

  it("logs and ignores a frame that is not JSON", async () => {
    const { port } = await startServer()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ws = await connect(port)
    ws.send("{")
    await vi.waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("failed to parse message"))
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it("lets the rate counter decay, also after the user left", async () => {
    const { port } = await startServer()
    const u = await makeUser()
    const ws = await authed(port, u.token)
    ws.send(JSON.stringify({ type: "noop" }))
    await sleep(1100)
    ws.send(JSON.stringify({ type: "noop" }))
    ws.close()
    await waitForClose(ws)
    await sleep(1100)
  })

  it("heartbeat: terminates a silent socket and closes an expired token", async () => {
    const { port } = await startServer({ heartbeatMs: 200, authTimeoutMs: 5000 })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const u = await makeUser()
    const silent = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false })
    sockets.push(silent)
    await new Promise((r) => silent.once("open", r))
    const expiring = await authed(port, sign(u.userId, { expiresIn: 1 }))

    const [s, e] = await Promise.all([waitForClose(silent), waitForClose(expiring, 4000)])
    expect(s.code).toBe(1006)
    expect(e).toEqual({ code: 4001, reason: "Unauthorized: Token expired" })
  })

  it("heartbeat: a failed revalidation signs nobody out, and skips sockets closed meanwhile", async () => {
    const { port, wss } = await startServer({ heartbeatMs: 200 })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const u = await makeUser()
    const ws = await authed(port, u.token)
    const real = pool.query.bind(pool)
    const query = vi
      .spyOn(pool, "query")
      .mockRejectedValueOnce(new Error("db blip"))
      .mockImplementationOnce(((...a: Parameters<typeof pool.query>) => {
        wss.clients.forEach((c) => c.close(1000, "bye"))
        return real(...a)
      }) as typeof pool.query)
    expect((await waitForClose(ws)).code).not.toBe(4001)
    expect(query).toHaveBeenCalledTimes(2)
    expect(err.mock.calls.flat().join(" ")).toContain("revalidation failed")
  })
})
