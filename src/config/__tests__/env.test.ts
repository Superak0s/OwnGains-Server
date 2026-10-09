import { describe, it, expect, afterEach } from "vitest"
import { envBool, envInt, readLocalOnlyFeatures } from "../env.js"

afterEach(() => {
  delete process.env.X_TEST
  delete process.env.LOCAL_ONLY_FEATURES
})

describe("env parsing fails at boot on a malformed value", () => {
  it("envInt", () => {
    expect(envInt("X_TEST", 7)).toBe(7)
    process.env.X_TEST = " 12 "
    expect(envInt("X_TEST", 7)).toBe(12)
    process.env.X_TEST = "30s"
    expect(() => envInt("X_TEST", 7)).toThrow('X_TEST must be an integer >= 0 (got "30s")')
    process.env.X_TEST = "0"
    expect(() => envInt("X_TEST", 7, 1)).toThrow(">= 1")
  })

  it("envBool", () => {
    expect(envBool("X_TEST", true)).toBe(true)
    process.env.X_TEST = "Yes"
    expect(envBool("X_TEST", false)).toBe(true)
    process.env.X_TEST = "off"
    expect(envBool("X_TEST", true)).toBe(false)
    process.env.X_TEST = "maybe"
    expect(() => envBool("X_TEST", true)).toThrow("X_TEST must be true or false")
  })

  it("readLocalOnlyFeatures", () => {
    expect(readLocalOnlyFeatures()).toEqual([])
    process.env.LOCAL_ONLY_FEATURES = " Tracking, ,supplements"
    expect(readLocalOnlyFeatures()).toEqual(["tracking", "supplements"])
    process.env.LOCAL_ONLY_FEATURES = "tracking,workouts"
    expect(() => readLocalOnlyFeatures()).toThrow('unknown feature "workouts"')
  })
})
