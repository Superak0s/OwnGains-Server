import os from "node:os"
import { envInt } from "@/config/env.js"
import { logger } from "@/utils/logger.js"

// Optional Telegram alerts, on only when both TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are set:
// - bot traffic: one IP sends many refused requests in a minute (unrouted
//   404s, 401, 403, 429), the shape of a scanner or a credential stuffer.
//   Keyed by req.ip, so a wrong TRUST_PROXY_HOPS pools every client into one IP.
// - health: p95, p99 or the 5xx rate over the last few minutes crosses its
//   limit, and again once it is back under.

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
export const botAlertsEnabled = Boolean(token && chatId)
/** Refused requests from one IP within one minute that trigger an alert. */
const THRESHOLD = envInt("BOT_ALERT_THRESHOLD", 60, 1)
/** An IP already reported is not reported again for this long. */
const COOLDOWN_MS = 60 * 60_000
const MAX_IPS = 10_000
const MAX_PATHS = 20
const MAX_LISTED = 10
const host = process.env.SERVER_FQDN || os.hostname()

/** A non-negative number (decimals allowed) from `name`, or `fallback`. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!(value >= 0)) throw new Error(`${name} must be a number >= 0 (got "${raw}")`)
  return value
}

/** Health alert limits. 0 turns one off. */
export const healthLimits = {
  p95Ms: envInt("ALERT_P95_MS", 500),
  p99Ms: envInt("ALERT_P99_MS", 1000),
  errorRatePct: envNumber("ALERT_ERROR_RATE_PCT", 1),
  /** Fewer requests than this in the window are too few to judge. */
  minRequests: envInt("ALERT_MIN_REQUESTS", 30, 1),
  windowMinutes: 5,
}

interface Hits {
  n: number
  byStatus: Map<number, number>
  paths: Map<string, number>
}

let hits = new Map<string, Hits>()
const lastAlert = new Map<string, number>()

const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1)

export const isSuspicious = (status: number, routed: boolean) =>
  status === 401 || status === 403 || status === 429 || (status === 404 && !routed)

export function noteSuspicious(ip: string | undefined, status: number, path: string): void {
  if (!botAlertsEnabled || !ip) return
  let h = hits.get(ip)
  if (!h) {
    if (hits.size >= MAX_IPS) return
    h = { n: 0, byStatus: new Map(), paths: new Map() }
    hits.set(ip, h)
  }
  h.n++
  bump(h.byStatus, status)
  if (h.paths.has(path) || h.paths.size < MAX_PATHS) bump(h.paths, path)
}

/** Run once a minute: reports the IPs over the threshold and starts a new minute. */
export async function checkBotTraffic(now = Date.now()): Promise<void> {
  const minute = hits
  hits = new Map()
  for (const [ip, at] of lastAlert) if (now - at >= COOLDOWN_MS) lastAlert.delete(ip)
  const over = [...minute]
    .filter(([ip, h]) => h.n >= THRESHOLD && !lastAlert.has(ip))
    .sort((a, b) => b[1].n - a[1].n)
  if (!over.length) return
  for (const [ip] of over) lastAlert.set(ip, now)
  const lines = over.slice(0, MAX_LISTED).map(([ip, h]) => {
    const statuses = [...h.byStatus].map(([s, c]) => `${s}×${c}`).join(" ")
    const top = [...h.paths].sort((a, b) => b[1] - a[1])[0]?.[0]
    return `${ip}: ${h.n} (${statuses}), top path ${top}`
  })
  if (over.length > MAX_LISTED) lines.push(`and ${over.length - MAX_LISTED} more IPs`)
  await send(
    `Bot traffic on ${host}: ${over.length} IP(s) with ${THRESHOLD}+ refused requests in the last minute\n${lines.join("\n")}`,
  )
}

export interface Health {
  requests: number
  serverErrors: number
  p95Ms: number | null
  p99Ms: number | null
}

const breached = new Set<string>()

/**
 * Run once a minute with the last windowMinutes of traffic. Sends one message
 * when a figure reaches its limit and one when it is back under, nothing in
 * between, and judges nothing while traffic is below minRequests.
 */
export async function checkHealth(h: Health): Promise<void> {
  if (!botAlertsEnabled || h.requests < healthLimits.minRequests) return
  const errorPct = (h.serverErrors / h.requests) * 100
  const checks: [string, number, number | null, string][] = [
    ["p95 latency", healthLimits.p95Ms, h.p95Ms, "ms"],
    ["p99 latency", healthLimits.p99Ms, h.p99Ms, "ms"],
    ["5xx rate", healthLimits.errorRatePct, Math.round(errorPct * 100) / 100, "%"],
  ]
  const lines: string[] = []
  for (const [name, limit, value, unit] of checks) {
    if (!limit || value == null) continue
    const over = value >= limit
    if (over === breached.has(name)) continue
    if (over) breached.add(name)
    else breached.delete(name)
    lines.push(`${over ? "Over" : "Back under"}: ${name} ${value}${unit} (limit ${limit}${unit})`)
  }
  if (lines.length)
    await send(
      `Health on ${host}, last ${healthLimits.windowMinutes} minutes, ${h.requests} requests\n${lines.join("\n")}`,
    )
}

async function send(text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) logger.warn(`Telegram bot alert failed: HTTP ${res.status}`)
  } catch (err) {
    // The URL holds the bot token, so it never reaches the log.
    logger.warn(`Telegram bot alert failed: ${String((err as Error)?.message).replaceAll(token!, "***")}`)
  }
}
