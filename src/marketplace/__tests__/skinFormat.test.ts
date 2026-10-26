import { describe, it, expect } from "vitest"
import { validateSkinUpload, swatchOf } from "../skinFormat.js"

const neon = {
  background: "#020617",
  surface: "#0b1020",
  accent: "#a78bfa",
  textPrimary: "#ede9fe",
  overlay: "rgba(15,23,42,0.5)",
}

const widget = { type: "todayWorkout", size: "large", order: 0 }

describe("validateSkinUpload", () => {
  it("accepts a theme-only skin", () => {
    const out = validateSkinUpload({
      name: " Neon Lifter ",
      skin: { format: 1, theme: { name: "Neon", colors: neon } },
    })
    expect(out.name).toBe("Neon Lifter")
    expect(out.description).toBe("")
    expect(out.skin.theme?.colors.accent).toBe("#a78bfa")
  })

  it("accepts a boards-only skin", () => {
    const out = validateSkinUpload({ name: "Stats", skin: { format: 1, boards: { home: [widget] } } })
    expect(out.skin.boards?.home).toEqual([widget])
  })

  it("rejects an unknown format", () => {
    expect(() => validateSkinUpload({ name: "x", skin: { format: 2, boards: { home: [widget] } } })).toThrow(/format/)
  })

  it("rejects a skin with neither part", () => {
    expect(() => validateSkinUpload({ name: "x", skin: { format: 1 } })).toThrow(
      "skin must include a theme or boards",
    )
  })

  it("names the failing path for a bad size", () => {
    expect(() =>
      validateSkinUpload({ name: "x", skin: { format: 1, boards: { home: [{ ...widget, size: "huge" }] } } }),
    ).toThrow(/skin\.boards\.home\[0\]\.size/)
  })

  it("rejects a named color", () => {
    expect(() =>
      validateSkinUpload({ name: "x", skin: { format: 1, theme: { name: "t", colors: { accent: "red" } } } }),
    ).toThrow(/skin\.theme\.colors\.accent/)
  })

  it("strips widget ids and unknown fields", () => {
    const out = validateSkinUpload({
      name: "x",
      skin: { format: 1, boards: { home: [{ ...widget, id: "abc", secret: 1, title: "Today" }] } },
    })
    expect(out.skin.boards?.home[0]).toEqual({ ...widget, title: "Today" })
  })
})

describe("swatchOf", () => {
  it("picks background, surface, accent and text", () => {
    expect(swatchOf({ format: 1, theme: { name: "n", colors: neon } })).toEqual([
      "#020617",
      "#0b1020",
      "#a78bfa",
      "#ede9fe",
    ])
  })

  it("is empty without a theme", () => {
    expect(swatchOf({ format: 1, boards: { home: [widget as never] } })).toEqual([])
  })
})
