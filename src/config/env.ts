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
 * MIN_APP_VERSION as x.y.z, or null when unset. Published on /healthz so the
 * Play build forces an update for anyone below it. Throws on a malformed value
 * rather than silently never forcing.
 */
export function readMinAppVersion(): string | null {
  const raw = process.env.MIN_APP_VERSION?.trim()
  if (!raw) return null
  if (!/^\d+\.\d+\.\d+$/.test(raw))
    throw new Error(`MIN_APP_VERSION must look like 1.2.3 (got "${raw}")`)
  return raw
}

// Features a deployment can refuse to store, to keep its disk footprint down.
const KNOWN_LOCAL_ONLY = ["tracking", "supplements"] as const

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
