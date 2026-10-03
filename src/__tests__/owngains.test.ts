import { describe, it, expect } from "vitest"
import { main } from "../owngains.js"
import { uniqueName } from "../tests/helpers.js"
import { createUser } from "../features/auth/auth.model.js"
import { reportUser } from "../features/social/friends/friends.model.js"
import { pool } from "../config/database.js"

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => logs.push(a.join(" "))
  console.error = (...a: unknown[]) => logs.push(a.join(" "))
  const prev = process.argv
  process.argv = ["node", "owngains", ...args]
  try {
    return { code: await main(), out: logs.join("\n") }
  } finally {
    console.log = origLog
    console.error = origErr
    process.argv = prev
  }
}

describe("owngains CLI", () => {
  it("prints usage and exits 0 with no command", async () => {
    const r = await runCli([])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Usage: owngains")
  })

  it("add/remove toggle the admin flag", async () => {
    const username = uniqueName("adm")
    await createUser(username, `${username}@test.local`, "Passw0rd-123")

    const missing = await runCli(["add"])
    expect(missing.code).toBe(2)

    const ghost = await runCli(["add", uniqueName("nope")])
    expect(ghost.code).toBe(2)
    expect(ghost.out).toContain("User not found")

    const add = await runCli(["add", username])
    expect(add.code).toBe(0)
    expect(add.out).toContain(`admin=true`)

    let [rows] = await pool.query("SELECT is_admin FROM users WHERE username = ?", [username])
    expect((rows as any[])[0].is_admin).toBe(1)

    // Removing the last admin is refused, since this CLI is the only way back in.
    // Other test files share this database and may have made their own admins
    // (the first user of a fresh database is one), so make this user the only
    // admin explicitly rather than assuming it.
    // The demotion is database-wide, so the admins other files made are put
    // back straight after the one CLI call that needs it. Left demoted, the
    // admin and metrics suites running in parallel failed with 403s.
    const [others] = await pool.query(
      "SELECT id FROM users WHERE is_admin = 1 AND username <> ?",
      [username],
    )
    const otherIds = (others as any[]).map((r) => r.id)
    await pool.query("UPDATE users SET is_admin = 0 WHERE username <> ?", [username])
    let lastOne: Awaited<ReturnType<typeof runCli>>
    try {
      lastOne = await runCli(["remove", username])
    } finally {
      if (otherIds.length)
        await pool.query("UPDATE users SET is_admin = 1 WHERE id IN (?)", [otherIds])
    }
    expect(lastOne.code).toBe(2)
    expect(lastOne.out).toContain("only admin")

    const second = uniqueName("adm2")
    await createUser(second, `${second}@test.local`, "Passw0rd-123")
    expect((await runCli(["add", second])).code).toBe(0)

    const remove = await runCli(["remove", username])
    expect(remove.code).toBe(0)
    expect(remove.out).toContain(`admin=false`)

    ;[rows] = await pool.query("SELECT is_admin FROM users WHERE username = ?", [username])
    expect((rows as any[])[0].is_admin).toBe(0)
  })

  it("create validates input, creates the user, and refuses duplicates", async () => {
    const username = uniqueName("mk")
    const email = `${username}@test.local`

    expect((await runCli(["create"])).code).toBe(2)
    expect((await runCli(["create", "a!", email, "Valid12345"])).code).toBe(2)
    expect((await runCli(["create", username, "nope", "Valid12345"])).code).toBe(2)
    expect((await runCli(["create", username, email, "short"])).code).toBe(2)

    // 8 characters, no digit or letter required.
    const ok = await runCli(["create", username, email, "!!!!!!!!", "--admin"])
    expect(ok.code).toBe(0)
    const [rows] = await pool.query("SELECT is_admin FROM users WHERE username = ?", [username])
    expect((rows as any[])[0].is_admin).toBe(1)

    expect((await runCli(["create", username, email, "Valid12345"])).code).toBe(1)
  })

  it("passwd validates input and resets the password", async () => {
    const username = uniqueName("pw")
    await createUser(username, `${username}@test.local`, "Passw0rd-123")

    expect((await runCli(["passwd"])).code).toBe(2)
    expect((await runCli(["passwd", username, "Short1a"])).code).toBe(2)
    expect((await runCli(["passwd", uniqueName("nope"), "Valid12345"])).code).toBe(2)

    const ok = await runCli(["passwd", username, "NewPass9999"])
    expect(ok.code).toBe(0)
    expect(ok.out).toContain("All existing sessions were signed out")

    const [rows] = await pool.query("SELECT password_hash FROM users WHERE username = ?", [username])
    const hash = (rows as any[])[0].password_hash as string
    const bcrypt = (await import("bcrypt")).default ?? (await import("bcrypt"))
    expect(await bcrypt.compare("NewPass9999", hash)).toBe(true)
  })

  it("lists every user with an admin marker, and reports", async () => {
    const admin = uniqueName("lsadm")
    const plain = uniqueName("lsuser")
    await createUser(admin, `${admin}@test.local`, "Passw0rd-123")
    await createUser(plain, `${plain}@test.local`, "Passw0rd-123")
    await runCli(["add", admin])

    const list = await runCli(["list"])
    expect(list.code).toBe(0)
    expect(list.out).toContain(`[admin] id=`)
    expect(list.out).toContain(admin)
    // The whole point of the change: a non-admin's spelling is visible too,
    // since `add`/`remove` need it exactly.
    expect(list.out).toContain(plain)

    const a = uniqueName("rep-a")
    const b = uniqueName("rep-b")
    await createUser(a, `${a}@test.local`, "Passw0rd-123")
    await createUser(b, `${b}@test.local`, "Passw0rd-123")
    const [rep] = await pool.query("SELECT id FROM users WHERE username = ?", [a])
    const [repd] = await pool.query("SELECT id FROM users WHERE username = ?", [b])
    await reportUser((rep as any[])[0].id, (repd as any[])[0].id, "spam", "test report")

    const reports = await runCli(["reports"])
    expect(reports.code).toBe(0)
    expect(reports.out).toContain(`reported ${b}`)
  })
})
