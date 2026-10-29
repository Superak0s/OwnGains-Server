import express, { Request, Response, NextFunction } from "express"
import http from "node:http"
import os from "node:os"
import cors from "cors"
import helmet from "helmet"
import compression from "compression"
import rateLimit, { type Options as RateLimitOptions } from "express-rate-limit"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { Bonjour, type Service } from "bonjour-service"
import { version } from "@/config/version.js"
import { startStaleSessionCleanup, stopStaleSessionCleanup } from "./jobs/sessionCleanup.js"
import { logger, logLevel, paint } from "./utils/logger.js"
import { envBool, envInt, readMinAppVersion } from "./config/env.js"
import {
  metricsBanner,
  metricsEnabled,
  metricsMiddleware,
  startMetricsCollector,
  stopMetricsCollector,
} from "./features/metrics/metrics.collector.js"

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET env var is not set")
if (process.env.JWT_SECRET.length < 32)
  throw new Error(
    "JWT_SECRET is too weak. Use at least 32 characters of high-entropy randomness",
  )
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
if (allowedOrigins.length === 0)
  throw new Error(
    "ALLOWED_ORIGINS env var is not set. Set it to a comma-separated list of allowed origins (e.g. https://yourapp.com)",
  )
// cors compares each array entry as an exact string, so "*" inside the list is
// never a wildcard: it matches no origin at all and every browser request
// fails CORS with no boot error to explain it.
if (allowedOrigins.includes("*"))
  throw new Error(
    "ALLOWED_ORIGINS does not support \"*\". List the origins explicitly, comma-separated (e.g. https://yourapp.com,http://localhost:3000)",
  )

// Fails at boot on a malformed value: Number("true") is NaN, and Express's
// trust-proxy check is false for NaN, so a typo would silently act like 0.
const trustProxyHops = envInt("TRUST_PROXY_HOPS", 0)

import { testDatabaseConnection, pool } from "./config/database.js"
import { checkZoneData } from "./utils/timeZone.js"
import { createWsServer, closeWsServer } from "./ws/wsServer.js"
import { registerRoutes, localOnlyFeatures, currentDisabledFeatures } from "./routes.js"
import { errorHandler } from "./middleware/errorHandler.js"
import { authenticateToken } from "./middleware/auth.js"
import updatesRoutes from "./features/updates/updates.routes.js"
import { photoQuota } from "./features/tracking/progressPhoto/progressPhoto.model.js"

// Declared here rather than in express.d.ts to keep it co-located with the
// only middleware that sets it. If other files need req.reqId, move it to
// src/types/express.d.ts alongside req.user.
declare global {
  namespace Express {
    interface Request {
      reqId?: string
    }
  }
}

/** The Express app, exported for tests. */
export const app = express()
const PORT = process.env.PORT || 5000

// Behind a reverse proxy, req.ip must come from X-Forwarded-For or
// express-rate-limit keys every client into one shared bucket. Exposed
// directly (the `docker run -p 5000:5000` path in the README) the header is
// entirely caller-supplied, so trusting a hop there lets an attacker rotate
// X-Forwarded-For and reset the auth limiter's bucket on every request.
// Default to 0 (req.ip is then the unspoofable socket address) and let a
// proxied deployment opt in with TRUST_PROXY_HOPS=1.
app.set("trust proxy", trustProxyHops)

// This is a JSON API with no HTML views, so lock CSP down to "load nothing"
// rather than the browser-page-oriented defaults helmet comes with.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"] },
    },
  }),
)

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
)

// Every response here is JSON, which gzips ~10x. Defaults are right for this
// box: the 1kb threshold skips the small writes that dominate the request
// count, and the built-in filter leaves already-compressed types alone, so
// progress-photo bytes don't get run through zlib for nothing.
app.use(compression())

app.use((req: Request, _res: Response, next: NextFunction) => {
  req.reqId = randomUUID()
  next()
})

// Ahead of the limiters, so a 429 and the time spent reaching it are counted.
if (metricsEnabled) app.use(metricsMiddleware)

const statusStyle = (status: number) =>
  status >= 500 ? "red" : status >= 400 ? "yellow" : status >= 300 ? "cyan" : "green"

// Logged on finish at debug level, as the matched route template: the raw
// path contains user content such as split and muscle names. The update
// check is left out: the privacy policy says it stores nothing.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path !== "/healthz" && !req.path.startsWith("/api/updates/")) {
    const started = performance.now()
    res.on("finish", () => {
      const fields = {
        auth: req.headers.authorization ? "present" : "missing",
        user: req.user?.uuid,
        actor: req.trainer?.uuid,
        ip: req.ip,
        reqId: req.reqId,
      }
      logger.debug(
        `${req.method} ${req.route ? req.baseUrl + req.route.path : "(unrouted)"} ${paint(
          statusStyle(res.statusCode),
          String(res.statusCode),
        )} ${Math.round(performance.now() - started)}ms`,
        paint(
          "dim",
          Object.entries(fields)
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
        ),
      )
    })
  }
  next()
})

// Loopback/private-range check for RATE_LIMIT_BYPASS_LOCAL_IPS. req.ip is the
// real client IP only when TRUST_PROXY_HOPS matches the deployment. Behind a
// same-host proxy with the default 0 it is 127.0.0.1 for *everyone*, which
// would turn this bypass into "no rate limiting at all". See the boot warning
// below.
const isLocalIp = (ip: string) =>
  /^(127\.|10\.|192\.168\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.)/.test(
    ip,
  ) ||
  /^(172\.(1[6-9]|2\d|3[01])\.|::ffff:172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

const bypassLocalIps = process.env.RATE_LIMIT_BYPASS_LOCAL_IPS === "true"

if (bypassLocalIps && trustProxyHops === 0)
  logger.warn(
    "⚠ RATE_LIMIT_BYPASS_LOCAL_IPS=true with TRUST_PROXY_HOPS=0. If this server " +
      "sits behind a reverse proxy, every request looks like 127.0.0.1 and BOTH " +
      "rate limiters are disabled for the entire internet. Set TRUST_PROXY_HOPS=1 " +
      "if proxied, or unset RATE_LIMIT_BYPASS_LOCAL_IPS.",
  )

// The suite hammers these endpoints from one IP. The limiters are a
// production protection, not something to mock around. Read per request,
// so a test that exercises a limiter can unset VITEST around itself.
const skipLimiter = (req: Request) =>
  !!process.env.VITEST || (bypassLocalIps && isLocalIp(String(req.ip)))

const limiter = (
  windowMs: number,
  max: number,
  extra: Partial<RateLimitOptions> = {},
) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipLimiter,
    message: {
      success: false,
      error: "Too many requests, please try again later",
    },
    ...extra,
  })

const FIFTEEN_MIN = 15 * 60 * 1000

// Strict per-IP limiters only where a request can guess or spray: the
// password-checking routes, and account creation. Everything else under
// /api/auth (/refresh, /me, /signout, /profile, /account/export) falls under
// the general /api limiter below: one shared auth bucket used to 429 every
// device behind the same NAT on /refresh and sign them all out.
// The credential limiter only counts failures (skipSuccessfulRequests), so a
// household signing in on several devices never reaches it. Signup counts every
// attempt, since a successful signup is exactly what a spammer wants. Both
// hold the old 20 per 15 minutes per IP.
const authRateLimit = envInt("AUTH_RATE_LIMIT", 20, 1)
const signupRateLimit = envInt("SIGNUP_RATE_LIMIT", 20, 1)
const apiRateLimit = envInt("API_RATE_LIMIT", 200, 1)
const credentialLimiter = limiter(FIFTEEN_MIN, authRateLimit, {
  skipSuccessfulRequests: true,
})
const signupLimiter = limiter(FIFTEEN_MIN, signupRateLimit)
app.post("/api/auth/signin", credentialLimiter)
app.post("/api/auth/google", credentialLimiter)
app.delete("/api/auth/google", credentialLimiter)
app.put("/api/auth/password", credentialLimiter)
app.delete("/api/auth/account", credentialLimiter)
app.delete("/api/auth/account/data", credentialLimiter)
app.post("/api/auth/reauth", credentialLimiter)
app.post("/api/auth/signup", signupLimiter)
// Ahead of the /api limiter with a higher cap of its own: every app launch and
// foreground checks, and the routes only read a few files from UPDATES_DIR.
app.use(
  "/api/updates",
  limiter(60 * 1000, envInt("UPDATES_RATE_LIMIT", 600, 1)),
  updatesRoutes,
)
app.use("/api", limiter(60 * 1000, apiRateLimit))

// Behind authenticateToken, so it's keyed by the account, not the IP: tokens
// are free to create, but each one is tied to one user, and this bounds how much
// synchronous JSON.parse CPU any account can buy with 2 MB bodies.
// Requests whose declared body fits the ordinary 50kb parser (and GETs, e.g.
// listing sharing permissions) aren't counted, since they cost what any other
// request does. A body with no Content-Length (chunked) is counted.
const LARGE_BODY_THRESHOLD = 50 * 1024
const largeBodyLimiter = limiter(
  FIFTEEN_MIN,
  envInt("LARGE_BODY_RATE_LIMIT", 20, 1),
  {
    // Behind authenticateToken, so req.user is always set.
    keyGenerator: (req) => `user:${req.user!.uuid}`,
    skip: (req) => {
      if (skipLimiter(req)) return true
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true
      const len = req.headers["content-length"]
      return len != null && Number(len) <= LARGE_BODY_THRESHOLD
    },
  },
)

// Each demo fill rewrites about a thousand rows in one transaction.
app.post(
  "/api/sessions/demo",
  authenticateToken,
  limiter(FIFTEEN_MIN, envInt("DEMO_FILL_RATE_LIMIT", 5, 1), {
    keyGenerator: (req) => `user:${req.user!.uuid}`,
  }),
)

// Body parsing comes AFTER the limiters, so a flood is rejected before the
// box pays to buffer and JSON.parse the payload. The program-upload cap is
// also behind authenticateToken: at 2 MB it's 40x the global limit, and an
// anonymous caller has no business making the server parse that (the token
// check fails on jwt.verify without touching the DB). Mounted ahead of the
// global 50kb parser, which skips bodies express.json has already parsed.
// POST /api/sharing/permissions with permissionType "program" sends the
// same document /api/program/upload does, so it needs the same ceiling. At
// 50kb a program with machineMeta notes failed with a raw body-parser 413.
for (const path of ["/api/program/upload", "/api/sharing/permissions"])
  app.use(
    path,
    authenticateToken,
    largeBodyLimiter,
    express.json({ limit: "2mb" }),
  )
// One encrypted progress photo per request, capped at 3 MB of base64 by the route.
app.use(
  "/api/sharing/tracking/messages",
  authenticateToken,
  largeBodyLimiter,
  express.json({ limit: "4mb" }),
)
app.use(express.json({ limit: "50kb" }))

// express.json leaves req.body undefined when no body (or no Content-Type)
// arrived. A route reading req.body.x then throws a TypeError that the error
// handler reports as a 500 for what is a 400. Normalize once, here.
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.body ??= {}
  next()
})

// Unauthenticated and outside the /api limiters, so a flood would otherwise
// take one of the pool's 8 connections per hit. The Docker healthcheck polls
// every 30s, so a few seconds of staleness costs nothing.
let dbProbe: { at: number; ok: boolean } = { at: 0, ok: false }
const DB_PROBE_TTL_MS = 5_000

// Set once shutdown() starts. /healthz then answers 503 so a load balancer or
// orchestrator stops routing here while in-flight requests finish, instead of
// sending new ones into a process that is about to close its pool.
let draining = false

/** Flip /healthz to 503 "DRAINING". Called by shutdown() and exported for tests. */
export function beginDrain(): void {
  draining = true
}

const minAppVersion = readMinAppVersion()

app.get("/healthz", async (_req: Request, res: Response) => {
  if (draining) {
    res.status(503).json({ status: "DRAINING" })
    return
  }
  if (Date.now() - dbProbe.at > DB_PROBE_TTL_MS) {
    let ok = true
    try {
      await pool.query("SELECT 1")
    } catch {
      ok = false
    }
    dbProbe = { at: Date.now(), ok }
  }
  if (!dbProbe.ok) {
    res.status(503).json({ status: "DOWN" })
    return
  }
  res.json({
    status: "OK",
    fqdn: process.env.SERVER_FQDN || null,
    localOnlyFeatures,
    disabledFeatures: currentDisabledFeatures(),
    minAppVersion,
  })
})

registerRoutes(app)

app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "Route not found" })
})

app.use(errorHandler)

const server = http.createServer(app)

// Node's defaults are wrong in both directions for this server. A 5s
// keep-alive is shorter than the ~60s idle timeout of every common reverse
// proxy / load balancer, so the proxy reuses a socket Node has just closed and
// the client gets an intermittent 502. headersTimeout must exceed it, or Node
// can drop a reused connection while the next request's headers are in
// flight. And the 300s requestTimeout lets a slow client tie up a buffered
// upload (up to 10 MB) for five minutes. Set as properties, not
// createServer() options: the latter refuses headersTimeout > requestTimeout,
// but the request timer already bounds the headers, so the order is moot.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
server.requestTimeout = 60_000

// LAN discovery is how a self-hosted box is found without knowing its IP, so
// it stays on by default. On a cloud VM or bare-metal host with a public NIC
// there is no LAN to discover it on, and getLanInterface() would pick the
// public interface and answer mDNS queries there: set MDNS_ENABLED=false.
const mdnsEnabled = envBool("MDNS_ENABLED", true)

// Advertised whenever MDNS_ENABLED, so a client on the same LAN can find this box
// even without SERVER_FQDN set.
// multicast-dns has no reliable way to pick the "real" LAN NIC on its own:
// on a machine with Docker/WSL/VirtualBox/Hyper-V adapters it can bind
// multicast to one of those instead, so the announcement never reaches the
// actual Wi-Fi/Ethernet network.
/**
 * Picks the address of a physical LAN adapter for mDNS, skipping virtual ones.
 *
 * @returns The IPv4 address, or undefined when none is found.
 */
export function getLanInterface(): string | undefined {
  const virtualAdapter = /loopback|vEthernet|VirtualBox|Virtual|VPN|Tailscale|ZeroTier|Docker/i
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (virtualAdapter.test(name)) continue
    const ipv4 = addrs?.find((a) => a.family === "IPv4" && !a.internal)
    if (ipv4) return ipv4.address
  }
  return undefined
}

/** What this instance is configured to do, as label/value rows for the boot log. Never secrets. */
function bootSummary(): [string, string | false | undefined][] {
  const lanIp = getLanInterface()
  const fqdn = process.env.SERVER_FQDN?.replace(/^https?:\/\//, "")
  const list = (items: string[]) => (items.length ? items.join(", ") : "none")
  const required = (name: string) => (envBool(name, true) ? "required" : "not required")
  const nodeEnv = process.env.NODE_ENV
  return [
    ["Local", `http://localhost:${PORT}`],
    ["LAN", lanIp && `http://${lanIp}:${PORT}`],
    ["Public", fqdn && `https://${fqdn}`],
    [
      "Runtime",
      `Bun ${process.versions.bun}, pid ${process.pid}, NODE_ENV=${nodeEnv ?? "(unset)"} (${
        nodeEnv === "development" ? "full error details in responses" : "error details masked"
      })`,
    ],
    [
      "Proxy",
      trustProxyHops === 0
        ? "TRUST_PROXY_HOPS=0, client IP is the socket address (set 1 behind a reverse proxy)"
        : `TRUST_PROXY_HOPS=${trustProxyHops}, client IP read from X-Forwarded-For`,
    ],
    [
      "Rate limits",
      `${apiRateLimit}/min on /api, ${authRateLimit} failed sign-ins and ${signupRateLimit} signups per 15min, per IP${
        bypassLocalIps ? " (LAN callers exempt)" : ""
      }`,
    ],
    ["CORS", allowedOrigins.join(", ")],
    ["Features", `local only: ${list(localOnlyFeatures)}, disabled: ${list(currentDisabledFeatures())}`],
    ["Consent", `Terms ${required("REQUIRE_TERMS_ACCEPTANCE")} for writes, health consent ${required("REQUIRE_HEALTH_CONSENT")} for health data`],
    [
      "Photos",
      !localOnlyFeatures.includes("tracking") &&
        `${photoQuota.perUserMb ? `${photoQuota.perUserMb} MB` : "no cap"} per user, ${
          photoQuota.totalGb ? `${photoQuota.totalGb} GB` : "no cap"
        } for the instance`,
    ],
    ["Min app", minAppVersion ?? "any version"],
    ["Log level", logLevel === "debug" ? "debug, every request is logged" : `${logLevel} (LOG_LEVEL=debug logs every request)`],
  ]
}

// Created in start() (not at import time) so importing app in tests doesn't
// open a multicast socket. `interface` is a real multicast-dns option that
// bonjour-service forwards but omits from its own (mistyped) ServiceConfig.
let bonjour: Bonjour | undefined
let mdnsService: Service | undefined

/** Connects the database, then starts the HTTP and WebSocket servers and mDNS. */
export async function start() {
  checkZoneData()
  await testDatabaseConnection()
  createWsServer(server)
  const b = mdnsEnabled
    ? new Bonjour({
        interface: getLanInterface(),
      } as ConstructorParameters<typeof Bonjour>[0])
    : undefined
  bonjour = b
  server.listen(PORT, () => {
    const rows = bootSummary()
    logger.info(paint(["bold", "green"], `🚀 OwnGains Server v${version} running on port ${PORT}`))
    for (const [label, value] of rows)
      if (value) logger.info(`   ${paint("bold", label.padEnd(12))} ${value}`)
    startStaleSessionCleanup()
    void startMetricsCollector()
    logger.info(
      metricsBanner({
        port: PORT,
        lanIp: getLanInterface(),
        fqdn: process.env.SERVER_FQDN || undefined,
      }),
    )

    if (!b) {
      logger.info("📡 mDNS advertising disabled (MDNS_ENABLED=false)")
      return
    }
    mdnsService = b.publish({
      name: "OwnGains Server",
      type: "owngains",
      port: Number(PORT),
      txt: { fqdn: process.env.SERVER_FQDN || "" },
    })
    logger.info(
      `📡 Advertising via mDNS as _owngains._tcp${
        process.env.SERVER_FQDN ? ` (fqdn: ${process.env.SERVER_FQDN})` : ""
      }`,
    )
  })
}

let shuttingDown = false

/**
 * Drains and stops the server, then exits. Safe to call more than once.
 *
 * @param exitCode - Process exit code.
 */
export function shutdown(exitCode: number) {
  // SIGTERM followed by SIGINT (or a signal during a crash) used to run the
  // whole teardown twice: a second server.close() errors, and a second
  // pool.end() rejects, straight back into the rejection handler.
  if (shuttingDown) return
  shuttingDown = true
  beginDrain()
  closeWsServer()
  // Saves the minute in progress, so it needs the pool still open.
  const metricsSaved = stopMetricsCollector()
  // A sweep mid-transaction would otherwise have pool.end() pulled out from under it.
  const sweepDone = stopStaleSessionCleanup()
  if (mdnsService) mdnsService.stop()
  bonjour?.destroy()
  // Backstop: a connection that refuses to end must not hold the process
  // hostage after a signal.
  setTimeout(() => process.exit(exitCode), 5000).unref()
  server.close(async () => {
    try {
      await sweepDone
      await metricsSaved
      await pool.end()
    } catch (err) {
      logger.error("Error closing DB pool:", err)
    }
    process.exit(exitCode)
  })
}

// Only boot when run directly (bun server.ts), so tests can
// import app without side effects. pathToFileURL makes relative launch
// scripts (e.g. `bun server.ts`) compare equal to import.meta.url.
const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href

/** Boots the server and hooks the process signals. Exported for tests. */
export function main(): void {
  start().catch((err) => {
    logger.error("Failed to start server:", err)
    process.exit(1)
  })

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down gracefully")
    shutdown(0)
  })

  process.on("SIGINT", () => {
    shutdown(0)
  })

  // Logged, not fatal. Every async listener here (Express 5 routes, the WS
  // message handler, timers) catches its own errors. A rejection that still
  // escapes is a bug in one request or one socket, and exiting on it turned
  // any such bug into an outage anyone could trigger on demand (one WS
  // frame `null` used to do exactly that). Logged with its stack so it gets
  // fixed. uncaughtException stays fatal: after a synchronous throw out of an
  // event handler, process state is no longer trustworthy.
  process.on("unhandledRejection", (reason) => {
    logger.error(
      "Unhandled promise rejection (process kept running):",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    )
  })

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err)
    shutdown(1)
  })
}

/* v8 ignore next -- only when launched as a script, never under test */
if (isMain) main()
