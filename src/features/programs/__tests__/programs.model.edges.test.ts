// The model's rejections and odd shapes, called directly so no validator
// stands in front of them.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { signup, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import * as p from "../programs.model.js"
import type { ProgramData } from "../programs.types.js"

const ex = (name: string, extra: Record<string, unknown> = {}) => ({ name, sets: 2, ...extra })
const plan = (days: unknown[], split?: string[]) => ({ days, split }) as unknown as ProgramData

/** Fails the next statement that contains `match`, once. */
function failOn(match: string, err: object) {
  vi.restoreAllMocks()
  const real = pool.execute.bind(pool)
  vi.spyOn(pool, "execute").mockImplementation(((sql: string, ...rest: unknown[]) => {
    if (sql.includes(match)) {
      vi.mocked(pool.execute).mockImplementation(real as never)
      return Promise.reject(Object.assign(new Error("injected"), err))
    }
    return (real as (...a: unknown[]) => unknown)(sql, ...rest)
  }) as never)
}

afterEach(() => vi.restoreAllMocks())

describe("programs model edges", () => {
  let userId: number

  beforeAll(async () => {
    userId = await internalId((await signup("progedge")).user.id)
  })

  it("orders unlisted splits last, merges a repeated name, and keeps an empty day", async () => {
    await p.upsertProgram(
      userId,
      plan(
        [
          {
            dayNumber: 1,
            split: {
              Zed: { exercises: [ex("Row", { reps: " ", sets: 0 })] },
              Beta: { exercises: [ex("Row")] },
              A: { exercises: [ex("Row")] },
              Listed: {},
            },
          },
          { dayNumber: 2 },
        ],
        ["Listed", "A"],
      ),
      "edge.csv",
    )
    const days = (await p.getProgramByUserId(userId))!.programData.days
    expect(Object.keys(days[0].split)).toEqual(["A", "Beta", "Zed"])
    expect(days[0].exercises[0].setsBySplit).toEqual({ A: 2, Beta: 2, Zed: 0 })
    expect(days[0].dayTitle).toBe("")
    expect(days[1].split).toEqual({})
  })

  it("accepts an upload with no days or split at all", async () => {
    await p.upsertProgram(userId, {} as ProgramData, "empty.csv")
    expect((await p.getProgramByUserId(userId))!.programData).toMatchObject({ split: [], days: [] })
  })

  it.each([
    [ex(" "), "Every exercise needs a name"],
    [ex("Row", { sets: "many" }), "sets must be a number"],
  ])("rejects %o", async (bad, message) => {
    await expect(p.upsertProgram(userId, plan([{ dayNumber: 1, split: { A: { exercises: [bad] } } }]), "x")).rejects.toThrow(message)
  })

  describe("edits", () => {
    beforeAll(async () => {
      await p.upsertProgram(userId, plan([{ dayNumber: 1, dayTitle: "D", split: { A: { exercises: [ex("Row")] } } }], ["A"]), "e.csv")
    })

    it("404s a missing slot or day", async () => {
      await expect(p.renameExercise(userId, 1, "A", 9, { newName: "X" })).rejects.toThrow("Exercise")
      await expect(p.addExercise(userId, 9, "A", ex("X"))).rejects.toThrow("Day 9")
    })

    it("sets or clears the catalog id on rename", async () => {
      await p.renameExercise(userId, 1, "A", 0, { newName: "Row", newExerciseId: " Cable_Row " })
      await p.renameExercise(userId, 1, "A", 0, { newName: "Row", newExerciseId: " " })
      const day = (await p.getProgramByUserId(userId))!.programData.days[0]
      expect(day.split.A.exercises[0].exerciseId).toBeNull()
    })

    it.each([
      [{ sets: 2 }, "Exercise name and sets are required"],
      [{ name: "X", sets: 1.5 }, "sets must be a non-negative integer"],
      [{ name: "X", sets: -1 }, "sets must be a non-negative integer"],
    ])("rejects an added exercise %o", async (bad, message) => {
      await expect(p.addExercise(userId, 1, "A", bad)).rejects.toThrow(message)
    })

    it("retries an add that lost the position race, and rethrows anything else", async () => {
      failOn("INSERT INTO program_exercises", { code: "ER_DUP_ENTRY" })
      expect((await p.addExercise(userId, 1, "A", ex("Curl"))).exerciseIndex).toBe(1)

      failOn("INSERT INTO program_exercises", { code: "ER_LOCK_DEADLOCK" })
      await expect(p.addExercise(userId, 1, "A", ex("Curl"))).rejects.toThrow("injected")
    })

    it("keeps given reps and drops blank ones", async () => {
      expect((await p.addExercise(userId, 1, "B", ex("Dip", { reps: " 8-12 " }))).exercise.reps).toBe("8-12")
      expect((await p.addExercise(userId, 1, "B", ex("Dip", { reps: " " }))).exercise).not.toHaveProperty("reps")
    })

    it("clears a machine field passed as undefined", async () => {
      await p.patchExerciseMachine(userId, 1, "A", 0, { selectedMachine: "Rack" })
      await p.patchExerciseMachine(userId, 1, "A", 0, { selectedMachine: undefined })
      const row = (await p.getProgramByUserId(userId))!.programData.days[0].split.A.exercises[0]
      expect(row.selectedMachine).toBeUndefined()
    })

    it.each([
      [1.5, "additionalSets must be an integer"],
      [-100, "fewer than 0 sets"],
      [3e9, "That many sets is out of range"],
    ])("rejects %d more sets", async (added, message) => {
      await expect(p.patchExerciseSets(userId, 1, "A", 0, added)).rejects.toThrow(message)
    })
  })
})
