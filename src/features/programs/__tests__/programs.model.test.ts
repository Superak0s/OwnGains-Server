import { describe, it, expect, beforeAll } from "vitest"
import { signup, internalId } from "../../../tests/helpers.js"
import { upsertProgram, getProgramByUserId } from "../programs.model.js"
import type { ProgramData } from "../programs.types.js"

// The program is relational now, so the thing to check is that rows
// reassemble into the JSON the app reads: per-split lists, the derived flat
// exercises[] with setsBySplit, a null exerciseId for a custom exercise, and
// the machine settings kept through a save/load round trip.
const plan: ProgramData = {
  split: ["PPL"],
  days: [
    {
      dayNumber: 1,
      dayTitle: "Push",
      primaryMuscles: ["chest"],
      secondaryMuscles: ["triceps"],
      exercises: [],
      split: {
        PPL: {
          exercises: [
            {
              name: "Bench",
              primaryMuscles: ["chest"],
              secondaryMuscles: [],
              sets: 4,
            },
            {
              name: "Fly",
              primaryMuscles: ["chest"],
              secondaryMuscles: ["triceps"],
              sets: 3,
              reps: "8-12",
              exerciseId: "Cable_Fly",
              machines: ["Machine A", "Smith"],
              selectedMachine: "Machine A",
              defaultMachine: "Smith",
              bestAcrossMachines: true,
              machineMeta: { "Machine A": { note: "seat 4", setting: "3" } },
            },
          ],
          totalSets: 7,
        },
      },
    },
  ],
}

describe("programs model", () => {
  let userId: number

  beforeAll(async () => {
    userId = await internalId((await signup("progm")).user.id)
  })

  it("round-trips a program through the relational tables", async () => {
    await upsertProgram(userId, plan, "plan.csv")
    const stored = await getProgramByUserId(userId)

    expect(stored?.originalFilename).toBe("plan.csv")
    const day = stored!.programData.days[0]
    expect(stored!.programData.split).toEqual(["PPL"])
    expect(day.dayTitle).toBe("Push")
    expect(day.primaryMuscles).toEqual(["chest"])

    const [bench, fly] = day.split.PPL.exercises
    expect(day.split.PPL.totalSets).toBe(7)
    expect(bench.exerciseId).toBe(null)
    expect(bench.sets).toBe(4)
    expect(fly.exerciseId).toBe("Cable_Fly")
    expect(fly.reps).toBe("8-12")
    expect(fly.machines).toEqual(["Machine A", "Smith"])
    expect(fly.machineMeta).toEqual({
      "Machine A": { note: "seat 4", setting: "3" },
    })

    // exercises[] is derived from the split rows, not stored alongside them.
    expect(day.exercises.map((e) => e.name)).toEqual(["Bench", "Fly"])
    expect(day.exercises[1].setsBySplit).toEqual({ PPL: 3 })
  })

  it("re-uploading replaces the program without duplicating days", async () => {
    await upsertProgram(userId, plan, "plan2.csv")
    const stored = await getProgramByUserId(userId)

    expect(stored?.originalFilename).toBe("plan2.csv")
    expect(stored!.programData.days).toHaveLength(1)
    expect(stored!.programData.days[0].split.PPL.exercises).toHaveLength(2)
  })
})
