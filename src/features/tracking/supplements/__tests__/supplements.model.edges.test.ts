// Reminder times through create and update, an update with nothing to set,
// and streaks that ended before yesterday.
import { describe, it, expect, beforeAll } from "vitest"
import { signup, internalId } from "../../../../tests/helpers.js"
import * as s from "../supplements.model.js"

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
let userId: number
beforeAll(async () => {
  userId = await internalId((await signup("supedge")).user.id)
})

describe("supplements model edges", () => {
  it("pads reminder times on create and update, and clears one", async () => {
    const id = await s.createSupplement(userId, { name: "Zinc", reminderEnabled: true, reminderTime: "8" })
    expect(await s.getSupplementById(userId, id)).toMatchObject({ reminderEnabled: true, reminderTime: "08:00" })
    await s.updateSupplement(userId, id, { reminderEnabled: false, reminderTime: "21:5" })
    expect(await s.getSupplementById(userId, id)).toMatchObject({ reminderEnabled: false, reminderTime: "21:05" })
    await s.updateSupplement(userId, id, { reminderEnabled: true, reminderTime: null })
    await s.updateSupplement(userId, id, {})
    expect(await s.getSupplementById(userId, id)).toMatchObject({ reminderEnabled: true, reminderTime: null })
  })

  it("has no intake today, and a streak only when the last day is today or yesterday", async () => {
    const id = await s.createSupplement(userId, { name: "Iron" })
    expect(await s.hasTakenTodayServer(userId, id)).toBeNull()
    await s.logSupplement(userId, id, 1, daysAgo(3))
    expect(await s.getStreak(userId, id)).toBe(0)
    await s.logSupplement(userId, id, 1, daysAgo(1))
    expect(await s.getStreak(userId, id)).toBe(1)
  })
})
