// console already has debug/info/warn/error. The only things to add are a
// timestamp and a colored level, which is what this is.
import { styleText } from "node:util"

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

type Style = Parameters<typeof styleText>[0]

/**
 * Colors `text` when stdout is a terminal. styleText checks the stream itself,
 * so `docker logs` and log files get plain text, and it honors NO_COLOR and
 * FORCE_COLOR.
 */
export const paint = (style: Style, text: string): string => styleText(style, text)

const LEVELS = ["debug", "info", "warn", "error"] as const
type Level = (typeof LEVELS)[number]
const LEVEL_STYLE: Record<Level, Style> = { debug: "gray", info: "cyan", warn: "yellow", error: ["red", "bold"] }

const rawLevel = process.env.LOG_LEVEL?.trim().toLowerCase() || "info"
const minLevel = LEVELS.indexOf(rawLevel as Level)
if (minLevel < 0)
  throw new Error(`LOG_LEVEL must be debug, info, warn or error (got "${process.env.LOG_LEVEL}")`)

/** The LOG_LEVEL in effect, for the boot summary. */
export const logLevel: Level = LEVELS[minLevel]!

const stamp =
  (level: Level) =>
  (...args: unknown[]) => {
    // error is the highest level, so the error sink below always runs.
    if (LEVELS.indexOf(level) < minLevel) return
    console[level](
      `${paint("dim", `[${new Date().toISOString()}]`)} ${paint(LEVEL_STYLE[level], level.toUpperCase())}`,
      ...args,
    )
    // A metrics bug must never turn into a logging failure.
    if (level === "error" && errorSink)
      try {
        errorSink(args)
      } catch {}
  }

/** Timestamped console logger with `debug`, `info`, `warn` and `error` levels. */
export const logger = {
  debug: stamp("debug"),
  info: stamp("info"),
  warn: stamp("warn"),
  error: stamp("error"),
}
