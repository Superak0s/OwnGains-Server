import { describe, expect, it } from "vitest"
import { containsBannedWord, displayNameError, usernameError } from "../nameFilter.js"
import { usernameFromEmail } from "../auth.model.js"
import { validateUsername } from "@/middleware/validation.js"

describe("containsBannedWord", () => {
  it.each(["fuck", "xX_FuCk_Xx", "f.u.c.k", "f u c k", "sh1t", "$hit", "bïtch", "big_cock", "Anal Lee"])(
    "refuses %s",
    (v) => expect(containsBannedWord(v)).toBe(true),
  )

  it.each(["Hancock", "Grapes", "Spicer", "Analise", "Cumberland", "Essex", "Ana Lee", "Dickens", "Torpedo", "Κώστας"])(
    "allows %s",
    (v) => expect(containsBannedWord(v)).toBe(false),
  )
})

describe("displayNameError", () => {
  it.each(["José Núñez", "Mary-Jane O'Neil", "李小龍", "Κώστας", "J.R. 2"])("allows %s", (v) =>
    expect(displayNameError(v)).toBeNull(),
  )

  it.each(["<script>", "a  b", " lead", "trail ", "emoji 💪", "zero​width", "-dash", "new\nline"])(
    "refuses %j",
    (v) => expect(displayNameError(v)).toMatch(/only contain/),
  )

  it("refuses a banned word with its own message", () => {
    expect(displayNameError("Big Shit")).toMatch(/isn't allowed/)
  })
})

describe("usernameError", () => {
  it("refuses banned words and allows clean names", () => {
    expect(usernameError("fuck_you")).not.toBeNull()
    expect(usernameError("kostas_99")).toBeNull()
  })

  it.each(["demo", "DeMo_fan", "xdemox"])("refuses %s, which looks like a demo account", (v) =>
    expect(usernameError(v)).toMatch(/demo/),
  )
})

describe("validateUsername", () => {
  it.each(["abc", "a1b2c3", "Kos_99", "abcdefghijklmnopqrst"])("allows %s", (v) => expect(validateUsername(v)).toBe(true))
  it.each(["ab", "a1_2b", "123456", "ab_12", "abcdefghijklmnopqrstu", "abc def"])("refuses %s", (v) =>
    expect(validateUsername(v)).toBe(false),
  )
})

describe("usernameFromEmail", () => {
  it("strips non-word characters and keeps capital W", () => {
    expect(usernameFromEmail("Walt.W@x.com")).toBe("WaltW")
  })

  it("prefixes a local part with too few letters", () => {
    expect(usernameFromEmail("a1@x.com")).toBe("usera1")
  })

  it("falls back to user for a demo-looking local part", () => {
    expect(usernameFromEmail("demo.guy@x.com")).toBe("user")
  })
})
