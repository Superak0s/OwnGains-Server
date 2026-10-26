// console already has info/warn/error. The only thing to add is a
// timestamp, which is what this is.

/** Receives every logger.error call. The admin metrics keep the recent ones. */
type ErrorSink = (args: unknown[]) => void
let errorSink: ErrorSink | null = null

/**
 * Registers a receiver for every `logger.error` call.
 *
 * @param sink - The receiver, or null to remove it.
 */
export function setErrorLogSink(sink: ErrorSink | null): void {
  errorSink = sink
}

const LEVELS = ["info", "warn", "error"] as const
type Level = (typeof LEVELS)[number]

const rawLevel = process.env.LOG_LEVEL?.trim().toLowerCase() || "info"
const minLevel = LEVELS.indexOf(rawLevel as Level)
if (minLevel < 0) throw new Error(`LOG_LEVEL must be info, warn or error (got "${process.env.LOG_LEVEL}")`)

const stamp =
  (level: Level) =>
  (...args: unknown[]) => {
    // error is the highest level, so the error sink below always runs.
    if (LEVELS.indexOf(level) < minLevel) return
    console[level](`[${new Date().toISOString()}] ${level.toUpperCase()}`, ...args)
    // A metrics bug must never turn into a logging failure.
    if (level === "error" && errorSink)
      try {
        errorSink(args)
      } catch {}
  }

/** Timestamped console logger with `info`, `warn` and `error` levels. */
export const logger = {
  info: stamp("info"),
  warn: stamp("warn"),
  error: stamp("error"),
}
