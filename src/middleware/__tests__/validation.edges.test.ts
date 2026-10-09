// The rejection paths validation.test.ts doesn't reach, one row each.
import { describe, it, expect } from "vitest"
import type { NextFunction, Request, Response } from "express"
import * as v from "../validation.js"

type Mw = (req: Request, res: Response, next: NextFunction) => void

/** The error text (message plus details), or "next" when the request passed. */
function run(mw: Mw, body: unknown, query: Record<string, unknown> = {}): string {
  try {
    let passed = false
    mw({ body, query } as unknown as Request, {} as Response, () => (passed = true))
    return passed ? "next" : "stalled"
  } catch (e) {
    const err = e as Error & { details?: string[] }
    return [err.message, ...(err.details ?? [])].join(" | ")
  }
}

const long = (n: number) => "x".repeat(n)
const ex = (extra: Record<string, unknown> = {}) => ({ name: "Squat", sets: 3, ...extra })
const upload = (days: unknown[], extra: Record<string, unknown> = {}) => ({
  weeklyPlan: { days, split: ["A"] },
  originalFilename: "p.xlsx",
  ...extra,
})
const day = (split: unknown, extra: Record<string, unknown> = {}) => ({ dayNumber: 1, split, ...extra })
const demoDay = (extra: Record<string, unknown> = {}) => ({ dayNumber: 1, dayTitle: "Legs", exercises: [ex()], ...extra })
const validReg = { username: "someone", email: "a@b.co", password: "Passw0rd-1" }

describe("validation edge cases", () => {
  it.each<[string, Mw, unknown, string]>([
    ["registration: no password", v.validateRegistration, { ...validReg, password: 5 }, "Password is required"],
    ["registration: long username", v.validateRegistration, { ...validReg, username: long(21) }, "username must not exceed 20"],
    ["registration: long email", v.validateRegistration, { ...validReg, email: `${long(251)}@b.co` }, "email must not exceed 255"],
    ["registration: no email", v.validateRegistration, { ...validReg, email: "" }, "Email is required"],
    ["registration: blank terms", v.validateRegistration, { ...validReg, termsVersion: " " }, "termsVersion must be"],
    ["profile: long name", v.validateProfileUpdate, { name: long(129) }, "name must not exceed 128"],
    ["profile: long email", v.validateProfileUpdate, { email: `${long(251)}@b.co` }, "email must not exceed 255"],
    ["login: long username", v.validateLogin, { username: long(256), password: "p" }, "Invalid credentials"],
    ["session: long title", v.validateSessionCreation, { dayNumber: 1, dayTitle: long(256) }, "dayTitle must not exceed"],
    ["session: numeric split", v.validateSessionCreation, { dayNumber: 1, dayTitle: "A", split: 3 }, "split must be a string"],
    ["set: long exercise name", v.validateSetTiming, { exerciseName: long(256) }, "exerciseName must not exceed"],

    ["demo: bad split, no days", v.validateDemoFill, { split: " " }, "split must be a non-empty string | days must be an array"],
    ["demo: day not an object", v.validateDemoFill, { days: [null] }, "days[0] must be an object"],
    [
      "demo: every day field wrong",
      v.validateDemoFill,
      { days: [{ dayNumber: 0, dayTitle: 3, exercises: [] }] },
      "days[0].dayNumber must be a positive integer | days[0].dayTitle is required | days[0].exercises must be an array",
    ],
    ["demo: long title", v.validateDemoFill, { days: [demoDay({ dayTitle: long(256) })] }, "days[0].dayTitle is too long"],
    [
      "demo: bad exercises",
      v.validateDemoFill,
      { days: [demoDay({ exercises: [null, { name: " ", sets: 11 }] })] },
      "exercises[0] must be an object | days[0].exercises[1].name must be a non-empty string | days[0].exercises[1].sets must be",
    ],
    ["demo: valid", v.validateDemoFill, { split: "Push", days: [demoDay()] }, "next"],

    ["upload: long filename", v.validateProgramUpload, upload([], { originalFilename: long(256) }), "originalFilename must not exceed"],
    ["upload: digit-string dayNumber", v.validateProgramUpload, upload([day(undefined, { dayNumber: " 2 " })]), "next"],
    ["upload: bad dayNumber string", v.validateProgramUpload, upload([day(null, { dayNumber: "two" })]), "dayNumber must be an integer"],
    ["upload: exercises not a list", v.validateProgramUpload, upload([day(null, { exercises: {} })]), "days[0].exercises must be an array"],
    ["upload: split not an object", v.validateProgramUpload, upload([day([])]), "split must be an object keyed by split name"],
    [
      "upload: too many splits",
      v.validateProgramUpload,
      upload([day(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`S${i}`, {}])))]),
      "split may have at most 20 splits",
    ],
    ["upload: blank split name", v.validateProgramUpload, upload([day({ " ": {} })]), "split names must be"],
    ["upload: split not an object", v.validateProgramUpload, upload([day({ A: 1 })]), '["A"] must be an object'],
    ["upload: split with no exercises", v.validateProgramUpload, upload([day({ A: {} })]), "next"],
    ["upload: exercise not an object", v.validateProgramUpload, upload([day({ A: { exercises: [1] } })]), "exercises[0] must be an object"],
    [
      "upload: string sets, bad machine fields",
      v.validateProgramUpload,
      upload([
        day({
          A: {
            exercises: [
              ex({ sets: "4", machines: [long(101)], selectedMachine: 1, bestAcrossMachines: "yes" }),
              ex({ sets: "x", bestAcrossMachines: true, defaultMachine: "Rack" }),
            ],
          },
        }),
      ]),
      ".machines must be an array | exercises[0].selectedMachine must be a string | exercises[0].bestAcrossMachines must be a boolean | exercises[1].sets must be",
    ],
    [
      "upload: too many slots",
      v.validateProgramUpload,
      upload(
        [1, 2].map(() =>
          day(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`S${i}`, { exercises: Array(50).fill(ex()) }]))),
        ),
      ),
      "at most 1500 exercise slots",
    ],
    [
      "upload: too many distinct names",
      v.validateProgramUpload,
      upload([
        day(
          Object.fromEntries(
            Array.from({ length: 11 }, (_, s) => [
              `S${s}`,
              { exercises: Array.from({ length: 50 }, (_, e) => ex({ name: `E${s}-${e}` })) },
            ]),
          ),
        ),
      ]),
      "at most 500 distinct exercises",
    ],

    ["patch: exercise and patch not objects", v.validateProgramExercisePatch, { exercise: 1, patch: [] }, "exercise must be an object | patch must be an object"],
  ])("%s", (_name, mw, body, expected) => {
    const out = run(mw, body)
    for (const part of expected.split(" | ")) expect(out).toContain(part)
  })

  it("stops listing problems after 20", () => {
    const err = run(v.validateProgramUpload, upload(Array(25).fill(null)))
    expect(err.split(" | ")).toHaveLength(21)
  })

  it("rejects a repeated query key", () => {
    const req = { query: { limit: ["1", "2"] } } as unknown as Request
    expect(() => v.queryLimit(req, { def: 10, max: 50 })).toThrow("limit must be given at most once")
  })

  it("checks optional notes, string lists and the list filters", () => {
    expect(() => v.requireOptionalNote(5)).toThrow("note must be a string")
    expect(() => v.requireStringList("a", "symptoms", { maxItems: 3, maxLength: 5 })).toThrow("must be an array of strings")
    const q = (query: Record<string, unknown>) => ({ query }) as unknown as Request
    expect(() => v.listMuscleFilter(q({ muscle: " " }))).toThrow("muscle must be a muscle group name")
    expect(() => v.listMuscleFilter(q({ muscle: ["a"] }))).toThrow("muscle must be a muscle group name")
  })
})
