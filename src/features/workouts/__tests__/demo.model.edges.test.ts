// fillDemoData called directly with days the app wouldn't send: an exercise
// repeated across days and a day with none. Also a user who already has a
// height, and a server keeping tracking and supplements on the device.
import { describe, it, expect, afterEach, vi } from "vitest"
import { signup, internalId } from "../../../tests/helpers.js"
import { updateUserProfile, getUserBodyData } from "../../auth/user.model.js"
import { fillDemoData } from "../demo.model.js"

afterEach(() => vi.unstubAllEnvs())

const days = [
  { dayNumber: 1, dayTitle: "A", exercises: [{ name: "DemoEdgeCurl", sets: 2 }] },
  { dayNumber: 2, dayTitle: "Empty", exercises: [] },
  { dayNumber: 3, dayTitle: "B", exercises: [{ name: "DemoEdgeCurl", sets: 1 }] },
]

describe("demo model edges", () => {
  it("skips an empty day and keeps an existing height", async () => {
    const id = await internalId((await signup("demoedge")).user.id)
    await updateUserProfile(id, { height_cm: 165 } as never)
    const result = await fillDemoData(id, days, null)
    expect(result.sessions).toBeGreaterThan(0)
    expect(result.tracking).toBeGreaterThan(0)
    expect((await getUserBodyData(id)).heightCm).toBe(165)
  })

  it("seeds no tracking when the server keeps it on the device", async () => {
    vi.stubEnv("LOCAL_ONLY_FEATURES", "tracking,supplements")
    const id = await internalId((await signup("demolocal")).user.id)
    expect((await fillDemoData(id, days, null)).tracking).toBe(0)
  })
})
