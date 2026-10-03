import { describe, it, expect, afterEach, vi } from "vitest"
import http from "http"
import jwt from "jsonwebtoken"
import WebSocket, { type WebSocketServer } from "ws"
import { createWsServer, sendToUser, type WsServerOptions } from "../wsServer.js"
import { createUser, findUserById } from "../../features/auth/auth.model.js"
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

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
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
      [a, b].map((u) => pool.execute<any[]>("SELECT id FROM users WHERE uuid = ?", [u.userId])),
    )
    const [js] = await pool.execute<any>("INSERT INTO joint_sessions (created_by) VALUES (?)", [ra[0].id])
    await pool.execute(
      "INSERT INTO joint_session_participants (joint_session_id, user_id) VALUES (?, ?), (?, ?)",
      [js.insertId, ra[0].id, js.insertId, rb[0].id],
    )

    const wsA = await authed(port, a.token)
    const wsB = await authed(port, b.token)
    const got: any[] = []
    const both = new Promise<void>((resolve) =>
      wsB.on("message", (raw) => {
        got.push(JSON.parse(raw.toString()))
        if (got.length === 2) resolve()
      }),
    )
    wsA.send(JSON.stringify({ type: "leave_joint_session", jointSessionId: js.insertId }))
    await both

    expect(got.map((m) => m.type).sort()).toEqual(["invite_status", "joint_session_ended"])
    expect(got.find((m) => m.type === "invite_status").status).toBe("session_ended")
    const [rows] = await pool.execute<any[]>("SELECT status FROM joint_sessions WHERE id = ?", [js.insertId])
    expect(rows[0].status).toBe("ended")
  })
})
