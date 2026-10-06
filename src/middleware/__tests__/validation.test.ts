import { describe, it, expect } from "vitest"
import type { NextFunction, Request, Response } from "express"
import {
  parseIntParam,
  queryLimit,
  validateRequired,
  validateRegistration,
  validateLogin,
  validateProfileUpdate,
  validatePasswordChange,
  validateWeightEntry,
  validateSessionCreation,
  validateSetTiming,
  parseBackdatedTimestamp,
} from "../validation.js"
import { ValidationError } from "../errorHandler.js"

type Mw = (req: Request, res: Response, next: NextFunction) => void

function run(
  mw: Mw,
  body: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
) {
  let nextCalled = false
  try {
    mw(
      { body, query, params: {} } as unknown as Request,
      {} as Response,
      () => (nextCalled = true),
    )
  } catch (e) {
    // The per-field text is in ValidationError.details, not .message, so
    // flatten both so an assertion can search one string.
    const err = e as Error & { details?: string[] }
    err.message = [err.message, ...(err.details ?? [])].join(" | ")
    return { nextCalled, err }
  }
  return { nextCalled, err: null as Error | null }
}

describe("parseIntParam", () => {
  it("parses positive integers", () => {
    expect(parseIntParam("5", "id")).toBe(5)
    expect(parseIntParam("123", "id")).toBe(123)
  })
  it("rejects zero, negatives, and non-numbers", () => {
    expect(() => parseIntParam("0", "id")).toThrow(ValidationError)
    expect(() => parseIntParam("-3", "id")).toThrow(ValidationError)
    expect(() => parseIntParam("abc", "id")).toThrow(ValidationError)
  })
})

describe("queryLimit", () => {
  it("falls back to the default when no limit is given", () => {
    expect(queryLimit({ query: {} } as never, { def: 10, max: 50 })).toBe(10)
  })
  it("uses a valid limit and clamps to the max", () => {
    expect(queryLimit({ query: { limit: "5" } } as never, { def: 10, max: 50 })).toBe(5)
    expect(queryLimit({ query: { limit: "999" } } as never, { def: 10, max: 50 })).toBe(50)
  })
  it("ignores non-numeric limits", () => {
    expect(queryLimit({ query: { limit: "abc" } } as never, { def: 10, max: 50 })).toBe(10)
  })
})

describe("parseBackdatedTimestamp", () => {
  it("returns null for missing values", () => {
    expect(parseBackdatedTimestamp(null, "loggedAt")).toBeNull()
    expect(parseBackdatedTimestamp(undefined, "loggedAt")).toBeNull()
  })
  it("accepts a valid past ISO date", () => {
    expect(parseBackdatedTimestamp("2024-01-15T10:00:00Z", "loggedAt")).toBe(
      "2024-01-15T10:00:00Z",
    )
  })
  it("rejects future dates and garbage", () => {
    const future = new Date(Date.now() + 48 * 3600 * 1000).toISOString()
    expect(() => parseBackdatedTimestamp(future, "loggedAt")).toThrow(
      "cannot be in the future",
    )
    expect(() => parseBackdatedTimestamp("not-a-date", "loggedAt")).toThrow(
      ValidationError,
    )
    expect(() => parseBackdatedTimestamp(12345, "loggedAt")).toThrow(
      ValidationError,
    )
  })
})

describe("validateRequired", () => {
  it("passes when all fields are present", () => {
    expect(run(validateRequired(["a", "b"]), { a: 1, b: "x" }).nextCalled).toBe(true)
  })
  it("rejects missing, null, or empty fields", () => {
    const r1 = run(validateRequired(["a", "b"]), { a: 1 })
    expect(r1.err).toBeInstanceOf(ValidationError)
    expect(r1.err!.message).toContain("b")
    expect(run(validateRequired(["a"]), { a: "" }).err).toBeInstanceOf(ValidationError)
    expect(run(validateRequired(["a"]), { a: null }).err).toBeInstanceOf(ValidationError)
  })
})

describe("validateRegistration", () => {
  const good = { username: "tester", email: "t@e.com", password: "Password12" }
  it("accepts a valid registration", () => {
    expect(run(validateRegistration, good).nextCalled).toBe(true)
  })
  it("rejects each missing/invalid field", () => {
    expect(run(validateRegistration, { ...good, username: undefined }).err!.message).toContain("Username is required")
    expect(run(validateRegistration, { ...good, username: "ab" }).err!.message).toContain("Username must be")
    expect(run(validateRegistration, { ...good, username: "bad user" }).err!.message).toContain("Username must be")
    expect(run(validateRegistration, { ...good, email: "nope" }).err!.message).toContain("Invalid email")
    expect(run(validateRegistration, { ...good, password: "short1a" }).err!.message).toContain("Password")
    expect(run(validateRegistration, { ...good, password: "nodigitshere" }).nextCalled).toBe(true) // length-only policy
  })
})

describe("validateLogin", () => {
  it("requires username and password", () => {
    expect(run(validateLogin, { username: "a" }).err).toBeInstanceOf(ValidationError)
    expect(run(validateLogin, { password: "x" }).err).toBeInstanceOf(ValidationError)
    expect(run(validateLogin, { username: "a", password: "x" }).nextCalled).toBe(true)
    expect(run(validateLogin, { username: ["a"], password: "x" }).err).toBeInstanceOf(ValidationError)
  })
})

describe("validateProfileUpdate", () => {
  it("passes when nothing is provided", () => {
    expect(run(validateProfileUpdate, {}).nextCalled).toBe(true)
  })
  it("validates name and email when provided", () => {
    expect(run(validateProfileUpdate, { name: "New Name" }).nextCalled).toBe(true)
    expect(run(validateProfileUpdate, { name: "   " }).err!.message).toContain("non-empty")
    expect(run(validateProfileUpdate, { name: 42 }).err!.message).toContain("non-empty")
    expect(run(validateProfileUpdate, { email: "bad" }).err!.message).toContain("Invalid email")
    expect(run(validateProfileUpdate, { email: "a@b.co" }).nextCalled).toBe(true)
  })
})

describe("validatePasswordChange", () => {
  it("requires both passwords", () => {
    expect(run(validatePasswordChange, { newPassword: "Password1" }).err!.message).toContain("Current password")
    expect(run(validatePasswordChange, { currentPassword: "Password1" }).err!.message).toContain("New password")
  })
  it("rejects weak new passwords", () => {
    expect(run(validatePasswordChange, { currentPassword: "Password1", newPassword: "weak" }).err).toBeInstanceOf(ValidationError)
    expect(run(validatePasswordChange, { currentPassword: "Password1", newPassword: "short1a" }).err).toBeInstanceOf(ValidationError)
    expect(run(validatePasswordChange, { currentPassword: "Password1", newPassword: "Password12" }).nextCalled).toBe(true)
    expect(run(validatePasswordChange, { currentPassword: "Password1", newPassword: "a1".repeat(37) }).err).toBeInstanceOf(ValidationError)
  })
})

// The 20-500 kg range moved into logMetrics (METRIC_BOUNDS) so that
// POST /measurements gets it too, and bodyStats.routes.test.ts covers it end to end.
describe("validateWeightEntry", () => {
  it("accepts a positive number", () => {
    expect(run(validateWeightEntry, { weightKg: 70 }).nextCalled).toBe(true)
  })
  it("rejects zero and non-numeric weights", () => {
    expect(run(validateWeightEntry, { weightKg: 0 }).err).toBeInstanceOf(ValidationError)
    expect(run(validateWeightEntry, { weightKg: "x" }).err).toBeInstanceOf(ValidationError)
  })
})

describe("validateSessionCreation", () => {
  const good = { dayNumber: 1, dayTitle: "Push Day" }
  it("accepts valid session data", () => {
    expect(run(validateSessionCreation, good).nextCalled).toBe(true)
  })
  it("rejects bad day number, missing title, and bad muscle arrays", () => {
    expect(run(validateSessionCreation, { ...good, dayNumber: 0 }).err!.message).toContain("Day number")
    expect(run(validateSessionCreation, { ...good, dayNumber: "x" }).err!.message).toContain("Day number")
    expect(run(validateSessionCreation, { dayNumber: 1 }).err!.message).toContain("Day title")
    expect(run(validateSessionCreation, { ...good, primaryMuscles: "chest" }).err!.message).toContain("primaryMuscles")
    expect(run(validateSessionCreation, { ...good, primaryMuscles: [""] }).err!.message).toContain("primaryMuscles")
    expect(run(validateSessionCreation, { ...good, secondaryMuscles: [42] }).err!.message).toContain("secondaryMuscles")
  })
})

describe("validateSetTiming", () => {
  const good = {
    exerciseName: "Bench Press",
    setIndex: 0,
    startTime: "2024-01-15T10:00:00Z",
    endTime: "2024-01-15T10:00:30Z",
    weight: 80,
    reps: 8,
    note: "good form",
    isWarmup: false,
    machineName: "rack",
  }
  it("passes with all fields valid and with an empty body", () => {
    expect(run(validateSetTiming, good).nextCalled).toBe(true)
    expect(run(validateSetTiming, {}).nextCalled).toBe(true)
  })
  it("accepts a bodyweight or failed set", () => {
    // ck_ws_weight / ck_ws_reps both allow 0, and omitting the field stores 0,
    // so sending 0 explicitly must not be a 400.
    expect(run(validateSetTiming, { weight: 0, reps: 0 }).err).toBeNull()
  })

  it("rejects malformed fields", () => {
    expect(run(validateSetTiming, { exerciseName: "  " }).err!.message).toContain("Exercise name")
    expect(run(validateSetTiming, { setIndex: -1 }).err!.message).toContain("Set index")
    expect(run(validateSetTiming, { startTime: "nope" }).err!.message).toContain("startTime")
    expect(run(validateSetTiming, { endTime: "nope" }).err!.message).toContain("endTime")
    expect(run(validateSetTiming, { weight: -5 }).err!.message).toContain("Weight")
    expect(run(validateSetTiming, { reps: -1 }).err!.message).toContain("Reps")
    // A far-future stamp is malformed too: a phone with a wrong clock used to
    // write sets that sorted above every real one forever.
    expect(run(validateSetTiming, { startTime: "2999-01-01T00:00:00Z" }).err!.message)
      .toContain("startTime")
    expect(run(validateSetTiming, { note: 42 }).err!.message).toContain("Note")
    expect(run(validateSetTiming, { isWarmup: "yes" }).err!.message).toContain("isWarmup")
    expect(run(validateSetTiming, { machineName: 5 }).err!.message).toContain("machineName")
    expect(run(validateSetTiming, { primaryMuscles: "chest" }).err!.message).toContain("primaryMuscles")
  })
})
