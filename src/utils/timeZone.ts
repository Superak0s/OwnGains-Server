import type { Request } from "express"
import { logger } from "./logger.js"

export const DAY_MS = 24 * 60 * 60 * 1000

/** The client's IANA zone from `X-Time-Zone`, or UTC when it is missing or unknown. */
export function requestTimeZone(req: Request): string {
  const zone = req.get("X-Time-Zone")
  if (!zone) return "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return zone
  } catch {
    return "UTC"
  }
}

/** YYYY-MM-DD of `instant` on the wall clock of `timeZone`. */
export function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant)
  const part = (type: string) => parts.find((p) => p.type === type)!.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

/** Logs an error when zone names don't resolve, since every client would then count days in UTC. */
export function checkZoneData(): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Athens" })
  } catch {
    logger.error("ICU zone data is missing: client time zones will fall back to UTC")
  }
}
