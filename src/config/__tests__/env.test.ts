import { describe, it, expect, afterEach } from "vitest"
import { envBool, envInt, readLocalOnlyFeatures, readMinAppVersion } from "../env.js"

afterEach(() => {
  delete process.env.X_TEST
  delete process.env.LOCAL_ONLY_FEATURES
  delete process.env.MIN_APP_VERSION
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

describe("readMinAppVersion", () => {
  it("is null when unset and the version when valid", () => {
    expect(readMinAppVersion()).toBeNull()
    process.env.MIN_APP_VERSION = " 0.5.1 "
    expect(readMinAppVersion()).toBe("0.5.1")
  })

  it("refuses a malformed value", () => {
    process.env.MIN_APP_VERSION = "v0.5"
    expect(() => readMinAppVersion()).toThrow("MIN_APP_VERSION must look like 1.2.3")
  })
})
