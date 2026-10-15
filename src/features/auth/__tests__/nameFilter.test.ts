import { describe, expect, it } from "vitest"
import { containsBannedWord, displayNameError, usernameError } from "../nameFilter.js"

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
})
