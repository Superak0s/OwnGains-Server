import { describe, it, expect } from "vitest"
import { runCli, uniqueName } from "../tests/helpers.js"
import { createUser } from "../features/auth/auth.model.js"
import { reportUser } from "../features/social/friends/friends.model.js"
import type { RowDataPacket } from "mysql2"
import { pool } from "../config/database.js"

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

    let [rows] = await pool.query<(RowDataPacket & { is_admin: number })[]>("SELECT is_admin FROM users WHERE username = ?", [username])
    expect(rows[0]!.is_admin).toBe(1)

    // The last-admin refusal is in owngains.mocked.test.ts: staging it here
    // meant demoting every other admin in the shared database.
    const second = uniqueName("adm2")
    await createUser(second, `${second}@test.local`, "Passw0rd-123")
    expect((await runCli(["add", second])).code).toBe(0)

    const remove = await runCli(["remove", username])
    expect(remove.code).toBe(0)
    expect(remove.out).toContain(`admin=false`)

    ;[rows] = await pool.query<(RowDataPacket & { is_admin: number })[]>("SELECT is_admin FROM users WHERE username = ?", [username])
    expect(rows[0]!.is_admin).toBe(0)
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
    const [rows] = await pool.query<(RowDataPacket & { is_admin: number })[]>("SELECT is_admin FROM users WHERE username = ?", [username])
    expect(rows[0]!.is_admin).toBe(1)

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

    const [rows] = await pool.query<(RowDataPacket & { password_hash: string })[]>("SELECT password_hash FROM users WHERE username = ?", [username])
    const hash = rows[0]!.password_hash
    const bcrypt = (await import("bcrypt")).default ?? (await import("bcrypt"))
    expect(await bcrypt.compare("NewPass9999", hash)).toBe(true)
  })

  it("rejects an unknown command and prints help on request", async () => {
    expect(await runCli(["nope"])).toEqual({ code: 2, out: "Unknown command" })
    expect((await runCli(["help"])).out).toContain("Usage: owngains")
  })

  it("suspend/unsuspend validate input, refuse admins and toggle disabled_at", async () => {
    const username = uniqueName("sus")
    await createUser(username, `${username}@test.local`, "Passw0rd-123")
    const disabled = async () => {
      const [rows] = await pool.query<(RowDataPacket & { d: string | null })[]>(
        "SELECT disabled_reason AS d FROM users WHERE username = ?",
        [username],
      )
      return rows[0]!.d
    }

    expect((await runCli(["suspend"])).out).toBe("Usage: owngains suspend <username> <reason>")
    expect((await runCli(["unsuspend"])).out).toBe("Usage: owngains unsuspend <username>")
    expect((await runCli(["suspend", uniqueName("nope"), "x"])).out).toContain("User not found")
    expect((await runCli(["suspend", username])).code).toBe(2)
    expect((await runCli(["suspend", username, "x".repeat(501)])).code).toBe(2)

    const sus = await runCli(["suspend", username, "spamming", "people"])
    expect(sus).toEqual({ code: 0, out: `User ${username} suspended and signed out everywhere.` })
    expect(await disabled()).toBe("spamming people")

    expect((await runCli(["unsuspend", username])).out).toBe(`User ${username} unsuspended.`)
    expect(await disabled()).toBeNull()

    const admin = uniqueName("susadm")
    await createUser(admin, `${admin}@test.local`, "Passw0rd-123")
    await runCli(["add", admin])
    expect((await runCli(["suspend", admin, "x"])).out).toContain("Refusing to suspend an admin")
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
    const [rep] = await pool.query<(RowDataPacket & { id: number })[]>("SELECT id FROM users WHERE username = ?", [a])
    const [repd] = await pool.query<(RowDataPacket & { id: number })[]>("SELECT id FROM users WHERE username = ?", [b])
    await reportUser(rep[0]!.id, repd[0]!.id, "spam", "test report")

    const reports = await runCli(["reports"])
    expect(reports.code).toBe(0)
    expect(reports.out).toContain(`reported ${b}`)
  })
})
