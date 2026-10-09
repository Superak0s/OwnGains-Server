import type * as Ws from "ws"
import http from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import jwt from "jsonwebtoken"
import type { RowDataPacket } from "mysql2/promise"
import { pool } from "../config/database.js"
import { envInt } from "../config/env.js"
import { findUserForAuth } from "../features/auth/auth.model.js"
import { logger } from "../utils/logger.js"
import {
  getJointSession,
  updateParticipantProgress,
  endJointSession,
} from "../features/social/sharing/sharing.model.js"
import type { JointSession, ParticipantProgress } from "../features/social/social.types.js"
import type { JwtPayload } from "../features/auth/auth.types.js"
import { isUuid } from "../middleware/validation.js"
import { NotFoundError } from "../middleware/errorHandler.js"

// Bun swaps a bare `import "ws"` for its own implementation, which ignores
// `maxPayload`, so an oversized frame would be buffered and handed to the
// message handler. Loading ws's own files by absolute path gets the real
// package on Bun and Node alike (a `ws/lib/...` specifier would be refused by
// its `exports` map on Node).
const require = createRequire(import.meta.url)
const wsLib = path.join(path.dirname(require.resolve("ws/package.json")), "lib")
const WebSocketServer: typeof Ws.WebSocketServer = require(path.join(wsLib, "websocket-server.js"))
const WebSocket: typeof Ws.WebSocket = require(path.join(wsLib, "websocket.js"))
type WebSocketServer = Ws.WebSocketServer
type WebSocket = Ws.WebSocket

interface WsUser {
  id: number
  uuid: string
  username: string
}

interface ProgressPayload extends ParticipantProgress {
  fromUserId?: string
}

interface WsMessage {
  type: string
  token?: unknown
  jointSessionId?: unknown
  progress?: ProgressPayload
}

// Only the state the heartbeat sweep needs, since it runs outside the
// per-connection closure, so it cannot reach that scope. Everything else
// (auth timer, pre-auth message count) stays closure-local.
interface ExtendedWebSocket extends WebSocket {
  _pongReceived?: boolean
  /** The user's public uuid: what the registry and the JWT are keyed by. */
  _userId?: string
  /** JWT `exp` (seconds) and token_version, re-checked by the heartbeat sweep. */
  _exp?: number
  _tokenVersion?: number
}

export interface WsServerOptions {
  /** Same meaning as Express's `trust proxy` hop count. Default: TRUST_PROXY_HOPS. */
  trustProxyHops?: number
  /** Sockets (pending auth + open) across the whole server. Default: WS_MAX_CONNECTIONS or 1000. */
  maxConnections?: number
  /** Sockets (pending auth + open) per client IP. Default: WS_MAX_CONNECTIONS_PER_IP or 20. */
  maxConnectionsPerIp?: number
  /** Time an unauthenticated socket gets to complete `auth`. Default 2s. */
  authTimeoutMs?: number
  /** Authenticated sockets one user may hold at once. Default: WS_MAX_SOCKETS_PER_USER or 5. */
  maxSocketsPerUser?: number
  /** Ping / revalidation sweep interval. Default 30s. */
  heartbeatMs?: number
}

// Keyed by user uuid, not the internal id: every sender already holds the
// uuid, since that is what route params and the JWT carry. A Set because one
// user legitimately has several devices (phone + tablet, or the phone and a
// trainer's view) connected at once. Every event fans out to all of them.
const clients = new Map<string, Set<WebSocket>>()

// Per-user message counter for rate limiting (messages in the last second),
// shared by all of that user's sockets.
// ⚠️  NOTE: In-process memory, so this server is single-instance only. Running
// multiple Node processes (PM2 cluster, k8s replicas) needs a shared store.
const msgCount = new Map<string, number>()

const MAX_PRE_AUTH_MESSAGES = 10
const MAX_MSG_PER_SEC = 20

function send(ws: WebSocket | undefined, type: string, payload: object): void {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type, ...payload }))
}

function sendToUser(userUuid: string, type: string, payload: object): void {
  const sockets = clients.get(userUuid)
  if (sockets) for (const ws of sockets) send(ws, type, payload)
}

/**
 * Whether anyone other than `userId` currently holds a socket.
 *
 * The live-set fan-out query (getLiveAudience) is a three-table join, and it
 * ran on every recorded set, including on a one-person instance,
 * where the lifter's own socket is the only one open and there is by
 * definition nobody to deliver to. Checking the map first skips it.
 */
export function hasOtherClients(userUuid: string): boolean {
  for (const id of clients.keys()) if (id !== userUuid) return true
  return false
}

/**
 * The client address, resolved exactly the way Express resolves `req.ip` for
 * a numeric `trust proxy` setting: walk from the socket address back through
 * X-Forwarded-For, trusting `hops` entries, and take the first untrusted one.
 * With 0 hops the header is ignored, since it's entirely caller-supplied.
 */
function clientIp(req: http.IncomingMessage, hops: number): string {
  /* v8 ignore next -- undefined only once the socket has closed */
  const remote = req.socket.remoteAddress ?? "unknown"
  if (hops === 0) return remote
  const header = req.headers["x-forwarded-for"]
  // String() joins a repeated header with commas, like the single form.
  const forwarded = String(header ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse()
  const chain = [remote, ...forwarded]
  return chain[Math.min(hops, chain.length - 1)]
}

function isWsMessage(value: unknown): value is WsMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  )
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0

type WsTokenCheck =
  | {
      payload: JwtPayload
      found: NonNullable<Awaited<ReturnType<typeof findUserForAuth>>>
    }
  | { reason: string }

/**
 * Every check authenticateToken makes, for a token that arrived over the
 * socket, shared by the initial `auth` frame and `auth.refresh`, so a refresh
 * can never be laxer than a fresh sign-in. A bad signature or an expired token
 * throws jwt.JsonWebTokenError. The other rejections come back as a reason for
 * the 4001 close. Anything else thrown is a server error (4002).
 */
async function verifyWsToken(token: string): Promise<WsTokenCheck> {
  const payload = jwt.verify(token, process.env.JWT_SECRET as string, {
    algorithms: ["HS256"],
  }) as JwtPayload

  // Same guard as authenticateToken: a pre-uuid token's numeric id must never
  // reach a `WHERE uuid = ?`.
  if (!isUuid(payload.userId)) return { reason: "invalid token" }

  const found = await findUserForAuth(payload.userId)
  if (!found) {
    logger.warn("[WS] user not found for userId:", payload.userId)
    return { reason: "User not found" }
  }
  if (found.tokenVersion !== payload.tokenVersion) {
    logger.warn("[WS] revoked token for userId:", payload.userId)
    return { reason: "Token has been revoked" }
  }
  return { payload, found }
}

/**
 * `auth.refresh`: the app hands over the access token it just refreshed, so
 * the heartbeat sweep checks the new `exp` instead of closing a live or joint
 * session at the old token's expiry. Only the token fields change: the socket,
 * its registry entry and any joint-session or watch membership stay as they
 * are. The token must belong to the user this socket is already signed in as.
 */
async function handleAuthRefresh(
  ws: ExtendedWebSocket,
  user: WsUser,
  data: WsMessage,
): Promise<void> {
  try {
    if (typeof data.token !== "string" || !data.token) {
      ws.close(4001, "Unauthorized: No token in auth.refresh message")
      return
    }
    const verified = await verifyWsToken(data.token)
    if ("reason" in verified) {
      ws.close(4001, `Unauthorized: ${verified.reason}`)
      return
    }
    if (verified.payload.userId !== user.uuid) {
      ws.close(4001, "Unauthorized: token belongs to another user")
      return
    }

    ws._exp = verified.payload.exp
    ws._tokenVersion = verified.payload.tokenVersion
    send(ws, "auth.refreshed", {})
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      ws.close(4001, `Unauthorized: ${err.message}`)
    } else {
      logger.error("[WS] auth.refresh failed:", (err as Error).message)
      ws.close(4002, "Server error during auth")
    }
  }
}

async function handlePushJointProgress(
  ws: WebSocket,
  user: WsUser,
  data: WsMessage,
): Promise<void> {
  const { jointSessionId, progress } = data
  if (!isPositiveInt(jointSessionId)) return
  const p: Partial<ProgressPayload> =
    typeof progress === "object" && progress !== null ? progress : {}

  const session: JointSession | null = await getJointSession(jointSessionId)
  if (!session?.participants.some((pt) => pt.userId === user.uuid))
    return send(ws, "error", { message: "Not a participant" })

  // An unfriend or a block ends the session in the DB (see blockUser /
  // removeFriend). updateParticipantProgress would refuse the write anyway.
  // This turns that into the event the client already knows how to handle
  // instead of a generic error it would retry.
  if (session.status !== "active")
    return send(ws, "joint_session_ended", { jointSessionId })

  // Broadcast what was stored, not what arrived: updateParticipantProgress
  // sanitises out-of-range indices, so the partner used to see a value the DB
  // never held.
  const stored = await updateParticipantProgress(jointSessionId, user.id, {
    exerciseIndex: p.exerciseIndex ?? null,
    setIndex: p.setIndex ?? null,
    exerciseName: p.exerciseName ?? null,
    readyForNext: p.readyForNext || false,
    exerciseNames: p.exerciseNames ?? null,
  })

  notifyJointProgress(session, user.uuid, stored)
}

async function handleLeaveJointSession(
  _ws: WebSocket,
  user: WsUser,
  data: WsMessage,
): Promise<void> {
  const { jointSessionId } = data
  if (!isPositiveInt(jointSessionId)) return
  // endJointSession only ends a session the caller is a participant in,
  // otherwise any authenticated client could end arbitrary sessions by
  // iterating the numeric id (IDOR). A non-participant is ignored, as before.
  let partnerId: string | null
  try {
    ;({ partnerId } = await endJointSession(jointSessionId, user.id))
  } catch (err) {
    if (err instanceof NotFoundError) return
    throw err
  }
  notifyJointSessionEnded(partnerId, jointSessionId)
}

/**
 * Tell the other participant their joint session is over. Both events go out:
 * the WS leave used to send `joint_session_ended` and the HTTP leave
 * `invite_status { status: "session_ended" }`, so an app listening for only
 * one missed the other path. Keep both until no released app relies on
 * either alone.
 */
export function notifyJointSessionEnded(
  partnerId: string | null,
  jointSessionId: number,
): void {
  if (!partnerId) return
  sendToUser(partnerId, "joint_session_ended", { jointSessionId })
  sendToUser(partnerId, "invite_status", {
    status: "session_ended",
    jointSession: null,
    jointSessionId,
  })
}

export { sendToUser }

export function notifyJointProgress(
  session: JointSession,
  fromUserId: string,
  progress: ProgressPayload,
): void {
  const partner = session.participants.find((p) => p.userId !== fromUserId)
  /* v8 ignore next -- a joint session always has a second participant */
  if (partner)
    sendToUser(partner.userId, "joint_progress", {
      jointSessionId: session.id,
      progress: { ...progress, fromUserId },
    })
}

/**
 * Current token_version for each uuid, in one query. Missing from the map =
 * the account no longer exists. pool.query (text protocol, client-side
 * escaping) rather than execute, so a varying IN-list length never turns into
 * a new server-side prepared statement. Never called with an empty list: the
 * heartbeat skips the sweep when no socket is signed in.
 */
async function fetchTokenVersions(uuids: string[]): Promise<Map<string, number>> {
  const versions = new Map<string, number>()
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT uuid, token_version FROM users WHERE uuid IN (?)",
    [uuids],
  )
  for (const row of rows)
    versions.set(row.uuid as string, Number(row.token_version))
  return versions
}

// Set by createWsServer and called from server.ts's shutdown() so SIGINT (not
// just SIGTERM) also closes WS connections gracefully.
let wsCleanup: (() => void) | null = null

export function closeWsServer(): void {
  wsCleanup?.()
}

/** Connection counts for the admin metrics page, or null before createWsServer. */
let connectionStats: (() => { total: number; distinctIps: number; maxConnections: number }) | null = null

export function getWsStats() {
  let authenticatedSockets = 0
  for (const sockets of clients.values()) authenticatedSockets += sockets.size
  const conn = connectionStats?.()
  return {
    running: conn != null,
    // Pending auth + open, as counted against WS_MAX_CONNECTIONS.
    connections: conn?.total ?? 0,
    maxConnections: conn?.maxConnections ?? null,
    distinctIps: conn?.distinctIps ?? 0,
    authenticatedSockets,
    connectedUsers: clients.size,
  }
}

export function createWsServer(
  httpServer: http.Server,
  options: WsServerOptions = {},
): WebSocketServer {
  const trustProxyHops = options.trustProxyHops ?? envInt("TRUST_PROXY_HOPS", 0)
  const maxConnections =
    options.maxConnections ?? envInt("WS_MAX_CONNECTIONS", 1000, 1)
  const maxConnectionsPerIp =
    options.maxConnectionsPerIp ?? envInt("WS_MAX_CONNECTIONS_PER_IP", 20, 1)
  const authTimeoutMs = options.authTimeoutMs ?? 2000
  const maxSocketsPerUser =
    options.maxSocketsPerUser ?? envInt("WS_MAX_SOCKETS_PER_USER", 5, 1)
  const heartbeatMs = options.heartbeatMs ?? 30_000

  // Every socket on this server, pending auth or open, by client IP. The
  // upgrade bypasses the Express limiters entirely, so without these one
  // client could open sockets until the box ran out of memory or descriptors.
  // Counted at the handshake and released when the underlying TCP socket
  // closes, which covers every way a connection can end.
  const perIp = new Map<string, number>()
  let total = 0
  let lastRejectLog = 0

  function reject(
    cb: (res: boolean, code?: number, message?: string, headers?: http.OutgoingHttpHeaders) => void,
    code: number,
    message: string,
    ip: string,
  ): void {
    // One line per 10s at most: a burst of rejected handshakes must not become
    // a burst of log writes.
    if (Date.now() - lastRejectLog > 10_000) {
      lastRejectLog = Date.now()
      logger.warn(`[WS] rejecting connections (${message}), e.g. from ${ip}; open=${total}`)
    }
    cb(false, code, message, { "Retry-After": "10" })
  }

  // maxPayload: ws defaults to 100 MB and buffers the entire frame before any
  // handler runs, so without this an unauthenticated socket could make the box
  // allocate 100 MB (twice, counting raw.toString()) before the auth timeout
  // or the pre-auth message cap had a chance to fire. Oversized frames are
  // closed with 1009 here, never reaching the message handler.
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 8 * 1024,
    verifyClient: (info, cb) => {
      const ip = clientIp(info.req, trustProxyHops)
      if (total >= maxConnections)
        return reject(cb, 503, "Too many connections", ip)
      const count = perIp.get(ip) ?? 0
      if (count >= maxConnectionsPerIp)
        return reject(cb, 429, "Too many connections from this address", ip)
      total++
      perIp.set(ip, count + 1)
      info.req.socket.once("close", () => {
        total--
        const n = perIp.get(ip)! - 1
        if (n > 0) perIp.set(ip, n)
        else perIp.delete(ip)
      })
      cb(true)
    },
  })

  let revalidating = false

  const heartbeat = setInterval(() => {
    const toCheck: ExtendedWebSocket[] = []
    wss.clients.forEach((ws) => {
      const ext = ws as ExtendedWebSocket
      if (ext._pongReceived === false) {
        logger.warn(`[WS] terminating stale connection uid=${ext._userId}`)
        ws.terminate()
        return
      }
      ext._pongReceived = false
      ws.ping()
      if (!ext._userId) return
      if (ext._exp != null && ext._exp * 1000 <= Date.now()) {
        ext.close(4001, "Unauthorized: Token expired")
        return
      }
      toCheck.push(ext)
    })
    // A sweep still waiting on the DB (saturated pool) is not stacked with
    // another. The next tick picks everything up again.
    if (revalidating || toCheck.length === 0) return
    revalidating = true
    revalidate(toCheck).finally(() => {
      revalidating = false
    })
  }, heartbeatMs)

  /**
   * A socket is authorized once, at its `auth` frame, and then read for as long
   * as it remains open. So `owngains passwd` (which bumps token_version and prints
   * "all existing sessions were signed out"), a deleted account, and an expired
   * JWT were all invisible to an already-open connection. Re-checked here, on
   * the sweep that is already walking every socket: one batched query for
   * every connected user (at most WS_MAX_CONNECTIONS), so the sweep uses one
   * pool connection instead of one query per socket.
   */
  async function revalidate(sockets: ExtendedWebSocket[]): Promise<void> {
    let versions: Map<string, number>
    try {
      versions = await fetchTokenVersions([...new Set(sockets.map((s) => s._userId!))])
    } catch (err) {
      // A DB blip must not sign everyone out. The next sweep retries.
      logger.error("[WS] revalidation failed:", (err as Error).message)
      return
    }
    for (const ext of sockets) {
      if (ext.readyState !== WebSocket.OPEN) continue
      if (versions.get(ext._userId!) !== ext._tokenVersion) {
        logger.warn(`[WS] revoked session, closing uid=${ext._userId}`)
        ext.close(4001, "Unauthorized: Token has been revoked")
      }
    }
  }

  wss.on("close", () => clearInterval(heartbeat))

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const extWs = ws as ExtendedWebSocket
    extWs._pongReceived = true

    logger.info("[WS] connection attempt")

    // Auth happens over the socket, never in the handshake URL: a long-lived
    // JWT in the URL would end up in server and proxy access logs. Set by the
    // `auth` message handler below, then read by every later message.
    let user: WsUser | null = null
    let authInFlight = false
    let preAuthMsgCount = 0

    // Cleared the moment `user` is set, so it only ever fires unauthenticated.
    const authTimeout = setTimeout(() => {
      logger.warn("[WS] auth timeout, no auth message received")
      ws.close(4001, "Unauthorized: No auth message")
    }, authTimeoutMs)

    async function handleAuth(msg: WsMessage): Promise<void> {
      logger.info("[WS] processing auth message")
      authInFlight = true
      try {
        if (typeof msg.token !== "string" || !msg.token) {
          logger.warn("[WS] auth message missing token")
          ws.close(4001, "Unauthorized: No token in auth message")
          return
        }

        const verified = await verifyWsToken(msg.token)
        if ("reason" in verified) {
          ws.close(4001, `Unauthorized: ${verified.reason}`)
          return
        }
        // The socket may have closed (or hit the auth timeout) while the
        // token was being checked. Its close handler has already run with no
        // user, so registering it now would leave a dead entry forever.
        if (ws.readyState !== WebSocket.OPEN) return
        const { payload, found } = verified

        const authed: WsUser = {
          id: found.user.id,
          uuid: found.user.uuid,
          username: found.user.username,
        }
        user = authed
        extWs._userId = authed.uuid
        extWs._exp = payload.exp
        extWs._tokenVersion = payload.tokenVersion
        // Cleared only now, not on arrival of the auth frame: a findUserForAuth
        // that hangs (saturated pool) would otherwise leave an unauthenticated
        // socket open with no timeout left.
        clearTimeout(authTimeout)

        logger.info(`[WS] authenticated via message uid=${authed.id}`)
        send(ws, "auth_success", { userId: authed.uuid })

        let sockets = clients.get(authed.uuid)
        if (!sockets) {
          sockets = new Set()
          clients.set(authed.uuid, sockets)
        }
        sockets.add(ws)
        // Past the per-user cap, the oldest socket goes, usually a zombie
        // from a network switch that the heartbeat hasn't reaped yet. close()
        // is a no-op on an already-closing socket.
        while (sockets.size > maxSocketsPerUser) {
          const oldest = sockets.values().next().value!
          sockets.delete(oldest)
          oldest.close(1000, "Replaced by new connection")
        }
        ws.on("pong", () => {
          extWs._pongReceived = true
        })
        logger.info(`[WS] connection ready uid=${authed.id}`)
      } catch (err) {
        logger.error("[WS] auth failed:", err)
        if (err instanceof jwt.JsonWebTokenError) {
          ws.close(4001, `Unauthorized: ${err.message}`)
        } else {
          ws.close(4002, "Server error during auth")
        }
      } finally {
        authInFlight = false
      }
    }

    /** Counts this frame against the pre-auth or per-user cap. False once the socket was closed for it. */
    function admitMessage(): boolean {
      if (user) return admitUserMessage(user.uuid)
      preAuthMsgCount++
      if (preAuthMsgCount <= MAX_PRE_AUTH_MESSAGES) return true
      ws.close(4001, "Unauthorized: too many messages before auth")
      return false
    }

    function admitUserMessage(uuid: string): boolean {
      // Rate limit per user. Not a fixed window: each message adds 1 to
      // the count and schedules its own -1 after 1s, so this is a decaying
      // counter ("no more than MAX_MSG_PER_SEC in-flight per rolling
      // second"), not a hard per-clock-second bucket.
      const count = (msgCount.get(uuid) ?? 0) + 1
      msgCount.set(uuid, count)
      setTimeout(() => {
        // Only decrement a live entry. The close handler deletes the key,
        // and a timer still pending from a message sent in the last second
        // would otherwise re-insert it and leak the entry for the life of
        // the process.
        if (!msgCount.has(uuid)) return
        msgCount.set(uuid, Math.max(0, msgCount.get(uuid)! - 1))
      }, 1000)
      if (count > MAX_MSG_PER_SEC) {
        // Tell the client why, then close. Replying alone left the socket
        // open, so a flooding client kept paying us to JSON.parse up to
        // 8KB, allocate a timer and write an error frame per message. A
        // legitimate client sends ~1 message per completed set, so this is
        // ~90x its peak rate and closing costs it nothing.
        send(ws, "error", { message: "Rate limit exceeded" })
        ws.close(4008, "Rate limit exceeded")
        return false
      }
      return true
    }

    async function handleMessage(raw: Ws.RawData): Promise<void> {
      // Counted before parsing, so a stream of garbage frames is capped
      // exactly like a stream of well-formed ones.
      if (!admitMessage()) return

      // No size check here: `maxPayload` above makes ws close the connection
      // with 1009 before any oversized frame reaches this handler.
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch (err) {
        logger.warn("[WS] failed to parse message:", (err as Error).message)
        return
      }
      // JSON.parse happily returns null, arrays, strings and numbers, and
      // `null.type` used to throw out of this async listener as an unhandled
      // rejection, which, before the process-level handler was made
      // non-fatal, took the whole server down on one unauthenticated frame.
      // NB: never log raw message bodies. The `auth` message contains the JWT.
      if (!isWsMessage(parsed)) {
        logger.warn("[WS] ignoring message that is not an object with a string type")
        return
      }
      const msg = parsed

      if (!user) {
        if (msg.type === "auth") {
          // A second auth frame while the first is still being verified would
          // race it into the registry, and the first one decides.
          if (!authInFlight) await handleAuth(msg)
          return
        }
        logger.warn("[WS] message received before authentication:", msg.type)
        send(ws, "error", { message: "Not authenticated" })
        return
      }
      const authedUser = user

      try {
        switch (msg.type) {
          case "push_joint_progress":
            await handlePushJointProgress(ws, authedUser, msg)
            break
          case "leave_joint_session":
            await handleLeaveJointSession(ws, authedUser, msg)
            break
          case "auth.refresh":
            await handleAuthRefresh(extWs, authedUser, msg)
            break
          default:
            logger.warn(`[WS] unknown type: ${msg.type.slice(0, 64)}`)
        }
      } catch (err) {
        // Mirror the HTTP error handler's polarity: deliberate 4xx messages
        // are safe to return, anything else is masked. Without this a driver
        // error from the handlers below reached the client verbatim, leaking
        // schema detail that the REST surface masks in production.
        const status = (err as { statusCode?: number }).statusCode ?? 500
        logger.error(`[WS] ${msg.type.slice(0, 64)} failed:`, (err as Error).message)
        send(ws, "error", {
          message: status < 500 ? (err as Error).message : "Server error",
        })
      }
    }

    ws.on("message", (raw: Ws.RawData) => {
      // Backstop for anything handleMessage didn't anticipate: an async
      // listener's rejection has nowhere else to go but the process.
      /* v8 ignore next 4 -- backstop: every path inside handleMessage catches its own errors */
      handleMessage(raw).catch((err) => {
        logger.error("[WS] message handler failed:", err)
        send(ws, "error", { message: "Server error" })
      })
    })

    ws.on("close", () => {
      // Only clear this socket's own entry: the user's other devices (or the
      // socket that replaced this one) keep theirs.
      if (user) {
        const sockets = clients.get(user.uuid)
        if (sockets?.delete(ws) && sockets.size === 0) {
          clients.delete(user.uuid)
          msgCount.delete(user.uuid)
        }
      }
      clearTimeout(authTimeout)
      logger.info(`[WS] disconnected uid=${extWs._userId}`)
    })

    ws.on("error", (err: Error) =>
      logger.error(`[WS] error uid=${extWs._userId}:`, err.message),
    )
  })

  connectionStats = () => ({ total, distinctIps: perIp.size, maxConnections })

  wsCleanup = () => {
    connectionStats = null
    clearInterval(heartbeat)
    // Every socket, not just authenticated ones: a socket still inside its
    // auth window is not in `clients` yet, and any open socket keeps the
    // shared http.Server alive, so shutdown()'s server.close() callback would
    // never run.
    wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"))
    clients.clear()
    msgCount.clear()
    wss.close()
  }

  return wss
}
