import { describe, it, expect } from "vitest"
import { formatDateForMySQL } from "../database.js"

describe("formatDateForMySQL", () => {
  it("formats a Date as a UTC MySQL datetime", () => {
    expect(formatDateForMySQL(new Date("2024-03-05T18:04:05Z"))).toBe("2024-03-05 18:04:05")
  })
  it("accepts ISO strings", () => {
    expect(formatDateForMySQL("2024-03-05T18:04:05Z")).toBe("2024-03-05 18:04:05")
  })
})
