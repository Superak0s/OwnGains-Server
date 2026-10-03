import fs from "node:fs"

// package.json is outside src/ (and outside dist/), so read it at runtime:
// src/config/ and dist/config/ are both two levels below the package root.
export const version: string = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version
