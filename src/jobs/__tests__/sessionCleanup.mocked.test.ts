// The sweep's failure and reporting paths, with every store mocked.
import { describe, it, expect, vi } from "vitest"

const m = vi.hoisted(() => ({
  endStaleSessions: vi.fn(),
  purgeDeletedAccounts: vi.fn(),
  purgeJointSessions: vi.fn(),
}))
vi.mock("../../features/workouts/workouts.model.js", () => ({ endStaleSessions: m.endStaleSessions }))
vi.mock("../../features/auth/auth.model.js", () => ({
  purgeDeletedAccounts: m.purgeDeletedAccounts,
  purgeExpiredRefreshTokens: vi.fn(),
}))
vi.mock("../../features/social/sharing/sharing.model.js", () => ({ purgeJointSessions: m.purgeJointSessions }))
vi.mock("../../middleware/idempotency.js", () => ({ purgeExpiredIdempotencyKeys: vi.fn() }))
vi.mock("../../features/auth/user.model.js", () => ({ purgeUnconsentedAccounts: vi.fn() }))
vi.mock("../../features/auth/throttle.model.js", () => ({ purgeStaleThrottles: vi.fn() }))
vi.mock("../../features/social/friends/friends.model.js", () => ({
  purgeExpiredCooldowns: vi.fn(),
  purgeOldReports: vi.fn(),
}))
vi.mock("../../ws/wsServer.js", () => ({ sendToUser: vi.fn() }))

const { logger } = await import("../../utils/logger.js")
const job = await import("../sessionCleanup.js")

describe("sessionCleanup sweep", () => {
  it("logs a failed run and a failed purge, and reports re-deleted accounts", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {})
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    m.endStaleSessions.mockRejectedValue(new Error("deadlock"))
    m.purgeJointSessions.mockRejectedValue(new Error("gone"))
    m.purgeDeletedAccounts.mockResolvedValue(2)
    await job.runStaleSessionCleanup()
    expect(error).toHaveBeenCalledWith("[SESSION_CLEANUP] Cleanup run failed:", "deadlock")
    expect(error).toHaveBeenCalledWith("[SESSION_CLEANUP] Joint-session purge failed:", "gone")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Re-deleted 2 account(s)"))
  })

  it("skips a tick while a run is in flight, and stops cleanly when never started", async () => {
    await job.stopStaleSessionCleanup()
    let finish!: (v: never[]) => void
    m.endStaleSessions.mockReset().mockReturnValue(new Promise((r) => (finish = r)))
    vi.useFakeTimers()
    try {
      job.startStaleSessionCleanup()
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(m.endStaleSessions).toHaveBeenCalledTimes(1)
      const stopped = job.stopStaleSessionCleanup()
      finish([])
      await stopped
    } finally {
      vi.useRealTimers()
    }
  })
})
