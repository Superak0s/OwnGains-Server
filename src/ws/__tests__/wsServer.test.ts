import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import http from "http"
import type { AddressInfo } from "net"
import jwt from "jsonwebtoken"
import WebSocket from "ws"
import { createWsServer, closeWsServer } from "../wsServer.js"
import { createUser, findUserById } from "../../features/auth/auth.model.js"
import { uniqueName } from "../../tests/helpers.js"

function tokenFor(userId: string, tokenVersion = 0): string {
  return jwt.sign({ userId, tokenVersion }, process.env.JWT_SECRET!, {
    algorithm: "HS256",
  })
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.on("open", () => resolve(ws))
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

describe("wsServer", () => {
  let httpServer: http.Server
  let port: number
  let sockets: WebSocket[] = []

  async function makeUser(username?: string): Promise<{ userId: string; token: string }> {
    const id = await createUser(
      username ?? uniqueName("ws"),
      `${uniqueName("ws")}@test.local`,
      "Passw0rd-123",
    )
    const userId = (await findUserById(id))!.uuid
    return { userId, token: tokenFor(userId) }
  }

  beforeAll(async () => {
    httpServer = http.createServer()
    createWsServer(httpServer)
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    port = (httpServer.address() as AddressInfo).port
  })

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close()
    }
    sockets = []
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    closeWsServer()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })

  it("authenticates via an auth message", async () => {
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    const msg = await nextMessage(ws)
    expect(msg.type).toBe("auth_success")
    expect(msg.userId).toBe(u.userId)
  })

  it("closes unauthenticated sockets after the auth timeout", async () => {
    const ws = await connect(port)
    sockets.push(ws)
    const close = await waitForClose(ws, 8000)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain("No auth message")
  })

  it.each([
    ["missing token", () => JSON.stringify({ type: "auth" }), "No token"],
    ["bad token", () => JSON.stringify({ type: "auth", token: "garbage" }), "Unauthorized"],
  ])("%s", async (_name, payload, reasonFragment) => {
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(payload())
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain(reasonFragment)
  })

  describe("auth.refresh", () => {
    async function authed(u: { token: string }): Promise<WebSocket> {
      const ws = await connect(port)
      sockets.push(ws)
      ws.send(JSON.stringify({ type: "auth", token: u.token }))
      expect((await nextMessage(ws)).type).toBe("auth_success")
      return ws
    }

    it("accepts a fresh token for the same user and keeps the socket", async () => {
      const u = await makeUser()
      const ws = await authed(u)
      const fresh = jwt.sign({ userId: u.userId, tokenVersion: 0 }, process.env.JWT_SECRET!, {
        algorithm: "HS256",
        expiresIn: "15m",
      })
      ws.send(JSON.stringify({ type: "auth.refresh", token: fresh }))
      expect(await nextMessage(ws)).toEqual({ type: "auth.refreshed" })

      // Still the same live, authenticated socket.
      ws.send(JSON.stringify({ type: "auth.refresh", token: fresh }))
      expect((await nextMessage(ws)).type).toBe("auth.refreshed")
      expect(ws.readyState).toBe(WebSocket.OPEN)
    })

    it.each([
      ["another user's token", async () => (await makeUser()).token, "token belongs to another user"],
      ["a revoked token", async (uuid: string) => tokenFor(uuid, 7), "revoked"],
      [
        "an expired token",
        async (uuid: string) =>
          jwt.sign({ userId: uuid, tokenVersion: 0, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!, {
            algorithm: "HS256",
          }),
        "jwt expired",
      ],
      ["garbage", async () => "garbage", "Unauthorized"],
      ["no token", async () => undefined, "No token"],
    ])("closes 4001 on %s", async (_name, makeToken, reasonFragment) => {
      const u = await makeUser()
      const ws = await authed(u)
      ws.send(JSON.stringify({ type: "auth.refresh", token: await makeToken(u.userId) }))
      const close = await waitForClose(ws)
      expect(close.code).toBe(4001)
      expect(close.reason).toContain(reasonFragment)
    })
  })

  it("closes a revoked token", async () => {
    const u = await makeUser()
    const revoked = tokenFor(u.userId, 999)
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: revoked }))
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain("revoked")
  })

  it("rejects messages before auth and caps pre-auth chatter", async () => {
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: 1 }))
    const err = await nextMessage(ws)
    expect(err.type).toBe("error")
    expect(err.message).toBe("Not authenticated")

    for (let i = 0; i < 11; i++) ws.send(JSON.stringify({ type: "noise" }))
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain("too many messages before auth")
  })

  // The server sets maxPayload, so an oversized frame is refused by the ws
  // protocol layer and the socket is closed with 1009 (Message Too Big):
  // the frame never reaches the handler, which is the entire point: it means
  // the box never buffers it. The in-handler size check is now unreachable
  // belt-and-braces rather than the enforcing guard it used to be.
  it("rejects oversized messages without buffering them", async () => {
    const ws = await connect(port)
    sockets.push(ws)
    ws.on("error", () => {})
    ws.send(JSON.stringify({ type: "noise", pad: "x".repeat(9000) }))
    const close = await waitForClose(ws)
    expect(close.code).toBe(1009)
  })

  it("rate limits more than 20 messages per second", async () => {
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws) // auth_success

    for (let i = 0; i < 25; i++) ws.send(JSON.stringify({ type: "noise" }))
    let limited = false
    for (let i = 0; i < 10 && !limited; i++) {
      const msg = await nextMessage(ws)
      if (msg.type === "error" && msg.message === "Rate limit exceeded") limited = true
    }
    expect(limited).toBe(true)
  })

  // Eviction past the per-user cap is covered in wsServer.platform.test.ts.
  // Under the default cap a second device no longer kicks the first off.
  it("keeps a second device of the same user connected alongside the first", async () => {
    const u = await makeUser()
    const ws1 = await connect(port)
    sockets.push(ws1)
    ws1.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws1)

    const ws2 = await connect(port)
    sockets.push(ws2)
    ws2.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws2)

    expect(ws1.readyState).toBe(WebSocket.OPEN)
    expect(ws2.readyState).toBe(WebSocket.OPEN)
  })

  it("pushes joint progress to the partner only for participants", async () => {
    // not a participant of session 999999
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws)
    ws.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: 999999 }))
    const err = await nextMessage(ws)
    expect(err.type).toBe("error")
    expect(err.message).toBe("Not a participant")
  })

  it("closes all sockets on shutdown", async () => {
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws)
    closeWsServer()
    const close = await waitForClose(ws)
    expect(close.code).toBe(1001)
  })
})
