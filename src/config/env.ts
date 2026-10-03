// Numeric/boolean env parsing shared by server.ts, config/database.ts and
// ws/wsServer.ts. Every reader fails at boot on a malformed value rather than
// silently falling back: Number("30s") is NaN, and a NaN limit compares false
// against everything, which quietly turns a cap into "no cap at all".

/** A non-negative integer from `name`, or `fallback` when unset/empty. */
export function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min)
    throw new Error(
      `${name} must be an integer >= ${min} (got "${raw}")`,
    )
  return value
}

/** `true`/`false` (also `1`/`0`, `yes`/`no`) from `name`, or `fallback`. */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (["true", "1", "yes", "on"].includes(raw)) return true
  if (["false", "0", "no", "off"].includes(raw)) return false
  throw new Error(`${name} must be true or false (got "${process.env[name]}")`)
}

/**
 * Number("true") is NaN, and Express's trust-proxy check (`hop < value`) is
 * false for NaN, so a misspelled value silently behaves like 0 and collapses
 * every client into one rate-limit bucket. Fail at boot instead. Read by both
 * Express (`trust proxy`) and the WebSocket server's per-IP connection cap, so
 * the two can never disagree about who the client is.
 */
export function readTrustProxyHops(): number {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0)
  if (!Number.isInteger(hops) || hops < 0)
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer (got "${process.env.TRUST_PROXY_HOPS}"): 0 when the port is exposed directly, 1 behind one reverse proxy`,
    )
  return hops
}

// Features a deployment can refuse to store, to keep its disk footprint down.
export const KNOWN_LOCAL_ONLY = ["tracking", "supplements"] as const

/**
 * LOCAL_ONLY_FEATURES, validated and lowercased: registerRoutes matches it
 * exactly, so "Tracking" or a typo used to mount the feature anyway *and*
 * still advertise it as local-only on /healthz: the operator's intent
 * silently inverted. Throws on an unknown name. The metrics page reads the
 * same list rather than re-parsing the variable its own way.
 */
export function readLocalOnlyFeatures(): string[] {
  return (process.env.LOCAL_ONLY_FEATURES ?? "")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean)
    .map((f) => {
      if (!(KNOWN_LOCAL_ONLY as readonly string[]).includes(f))
        throw new Error(
          `LOCAL_ONLY_FEATURES: unknown feature "${f}". Accepted values are: ${KNOWN_LOCAL_ONLY.join(", ")}`,
        )
      return f
    })
}
