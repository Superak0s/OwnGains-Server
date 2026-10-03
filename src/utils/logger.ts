// console already has info/warn/error. The only thing to add is a
// timestamp, which is what this is.

/** Receives every logger.error call. The admin metrics keep the recent ones. */
type ErrorSink = (args: unknown[]) => void
let errorSink: ErrorSink | null = null

export function setErrorLogSink(sink: ErrorSink | null): void {
  errorSink = sink
}

const stamp =
  (level: "info" | "warn" | "error") =>
  (...args: unknown[]) => {
    console[level](`[${new Date().toISOString()}] ${level.toUpperCase()}`, ...args)
    // A metrics bug must never turn into a logging failure.
    if (level === "error" && errorSink)
      try {
        errorSink(args)
      } catch {}
  }

export const logger = {
  info: stamp("info"),
  warn: stamp("warn"),
  error: stamp("error"),
}
