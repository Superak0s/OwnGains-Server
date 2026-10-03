import { describe, it, expect } from "vitest"
import { spawn } from "child_process"

// The in-process suite imports `app` directly, so this covers the one thing it
// can't: booting server.ts as a real process and exiting 0 on SIGTERM.
describe("server boot (integration)", () => {
  // Windows has no real SIGTERM: process.kill terminates the child outright, so
  // the exit code says nothing about shutdown(). Docker/CI run Linux anyway.
  it.skipIf(process.platform === "win32")("boots and shuts down cleanly on SIGTERM", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "18391" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const exited = new Promise<number>((resolve) =>
      child.on("exit", (code) => resolve(code ?? -1)),
    )
    await new Promise<void>((resolve, reject) => {
      let out = ""
      const timer = setTimeout(
        () => reject(new Error(`server did not boot in 25s: ${out}`)),
        25000,
      )
      const watch = (c: Buffer) => {
        out += c.toString()
        if (out.includes("running on port")) {
          clearTimeout(timer)
          resolve()
        }
      }
      child.stdout!.on("data", watch)
      child.stderr!.on("data", watch)
      child.on("exit", (code) =>
        reject(new Error(`server exited early (${code}): ${out}`)),
      )
    })
    child.kill("SIGTERM")
    expect(await exited).toBe(0)
  }, 40000)
})
