import { describe, it, expect, beforeEach, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import {
  createBackup,
  listBackups,
  pruneBackups,
  resolveBackup,
  restoreBackup,
  verifyBackup,
} from "../backup.js"
import { runCli } from "../../tests/helpers.js"

// mysqldump, mysql and age are replaced by one Bun script, so the suite needs
// none of them installed.
const fake = `${process.execPath} ${fileURLToPath(new URL("../../tests/fakebin.mjs", import.meta.url))}`
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "og-backup-"))
  process.env.BACKUP_DIR = dir
  process.env.MYSQLDUMP = `${fake} dump`
  process.env.MYSQL = `${fake} mysql`
  process.env.AGE = `${fake} age`
  process.env.FAKE_MYSQL_OUT = join(dir, "restored.sql")
  delete process.env.BACKUP_AGE_RECIPIENT
  delete process.env.FAKE_DUMP_FAIL
  delete process.env.FAKE_AGE_FAIL
})

const old = (name: string, days: number) => {
  const path = join(dir, name)
  writeFileSync(path, "x")
  const t = (Date.now() - days * 86_400_000) / 1000
  utimesSync(path, t, t)
  return path
}

describe("backup", () => {
  it("writes, verifies and restores a plain backup, keeping tombstones additive", async () => {
    const out = await createBackup()
    expect(out).toMatch(/owngains-\d{8}-\d{6}\.sql\.gz$/)
    expect(await verifyBackup(out)).toEqual({ bytes: expect.any(Number) })

    await restoreBackup(out)
    const sql = readFileSync(process.env.FAKE_MYSQL_OUT!, "utf8")
    expect(sql).toContain("CREATE TABLE `users`")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `deleted_accounts`")
  })

  it("encrypts with age and needs an identity to read it back", async () => {
    process.env.BACKUP_AGE_RECIPIENT = "age1test"
    const out = await createBackup()
    expect(out.endsWith(".age")).toBe(true)
    await expect(verifyBackup(out)).rejects.toThrow("--identity")
    await expect(restoreBackup(out)).rejects.toThrow("--identity")
    expect((await verifyBackup(out, "key.txt")).bytes).toBeGreaterThan(0)
    await restoreBackup(out, "key.txt")
    expect(readFileSync(process.env.FAKE_MYSQL_OUT!, "utf8")).toContain("deleted_accounts")
  })

  it("removes the partial file when the dump fails", async () => {
    process.env.FAKE_DUMP_FAIL = "1"
    await expect(createBackup()).rejects.toThrow("exited with code 3")
    expect(readdirSync(dir)).toEqual([])
  })

  it("still throws the write error when the partial file can't be removed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2020-01-01T00:00:00Z"))
    try {
      // A directory where the .part file goes fails the write and the unlink.
      mkdirSync(join(dir, `owngains-20200101-000000.sql.gz.${process.pid}.part`))
      await expect(createBackup()).rejects.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it("falls back to the default binaries, connection and directory", async () => {
    const saved = { ...process.env }
    for (const k of ["MYSQLDUMP", "MYSQL", "AGE", "DB_HOST", "DB_PORT", "DB_PASSWORD"]) delete process.env[k]
    // Nothing on PATH, so each default binary fails to spawn.
    process.env.PATH = ""
    try {
      await expect(createBackup()).rejects.toThrow()
      process.env.BACKUP_AGE_RECIPIENT = "age1test"
      await expect(createBackup()).rejects.toThrow()
      const enc = join(dir, "owngains-20200101-000000.sql.gz.age")
      writeFileSync(enc, "x")
      await expect(verifyBackup(enc, "key.txt")).rejects.toThrow()
      await expect(restoreBackup(join(dir, "nope.sql.gz"))).rejects.toThrow()
      delete process.env.BACKUP_DIR
      expect(Array.isArray(await listBackups())).toBe(true)
    } finally {
      process.env = saved
    }
  })

  it("rejects a dump that stopped partway", async () => {
    const path = join(dir, "owngains-20200101-000000.sql.gz")
    writeFileSync(path, gzipSync("CREATE TABLE t;\n-- Dump completed\n"))
    await expect(verifyBackup(path)).rejects.toThrow("1/2 dumps finished")
  })

  it("needs DB_USER and DB_NAME", async () => {
    const user = process.env.DB_USER
    delete process.env.DB_USER
    try {
      await expect(restoreBackup(join(dir, "x.sql.gz"))).rejects.toThrow("DB_USER and DB_NAME")
    } finally {
      process.env.DB_USER = user
    }
  })

  it("lists by name newest first, prunes by age and resolves names", async () => {
    process.env.BACKUP_DIR = join(dir, "missing")
    expect(await listBackups()).toEqual([])
    await expect(resolveBackup("latest")).rejects.toThrow("No backups")
    process.env.BACKUP_DIR = dir

    old("owngains-20200101-000000.sql.gz", 40)
    const newer = old("owngains-20200102-000000.sql.gz", 1)
    writeFileSync(join(dir, "notes.txt"), "ignored")

    expect((await listBackups()).map((b) => b.name)).toEqual([
      "owngains-20200102-000000.sql.gz",
      "owngains-20200101-000000.sql.gz",
    ])
    expect(await resolveBackup("latest")).toBe(newer)
    expect(await resolveBackup(newer)).toBe(newer)
    expect(await resolveBackup("owngains-20200102-000000.sql.gz")).toBe(newer)
    await expect(resolveBackup("nope.sql.gz")).rejects.toThrow("Backup not found")

    expect(await pruneBackups()).toEqual(["owngains-20200101-000000.sql.gz"])
    expect((await listBackups()).length).toBe(1)
  })
})

describe("owngains backup CLI", () => {
  it("create, list, verify and restore", async () => {
    expect((await runCli(["backup", "list"])).out).toContain("No backups in")

    old("owngains-20200101-000000.sql.gz", 40)
    const created = await runCli(["backup", "create"])
    expect(created.code).toBe(0)
    expect(created.out).toContain("pruned owngains-20200101-000000.sql.gz")
    expect((await runCli(["backup", "create"])).out).not.toContain("pruned")

    expect((await runCli(["backup", "list"])).out).toMatch(/- owngains-.* MB/)
    expect((await runCli(["backup", "verify", "latest"])).out).toContain("is complete")

    const refused = await runCli(["backup", "restore", "latest"])
    expect(refused.code).toBe(2)
    expect(refused.out).toContain("re-run with --yes")
    expect(existsSync(process.env.FAKE_MYSQL_OUT!)).toBe(false)

    const restored = await runCli(["backup", "restore", "latest", "--yes"])
    expect(restored.code).toBe(0)
    expect(restored.out).toContain("Saved the current database to")
    expect(existsSync(process.env.FAKE_MYSQL_OUT!)).toBe(true)
  })

  it("passes --identity through and reports usage errors", async () => {
    process.env.BACKUP_AGE_RECIPIENT = "age1test"
    await runCli(["backup", "create"])
    expect((await runCli(["backup", "verify", "latest"])).code).toBe(1)
    expect((await runCli(["backup", "verify", "latest", "--identity", "k"])).code).toBe(0)

    expect((await runCli(["backup"])).code).toBe(2)
    expect((await runCli(["backup", "verify", "--identity", "k"])).code).toBe(2)
  })

  it("prune fails loudly when nothing is left", async () => {
    old("owngains-20200102-000000.sql.gz", 1)
    expect(await runCli(["backup", "prune"])).toEqual({ code: 0, out: "Nothing to prune" })

    process.env.BACKUP_RETENTION_DAYS = "1"
    try {
      const r = await runCli(["backup", "prune"])
      expect(r.code).toBe(1)
      expect(r.out).toContain("Deleted owngains-20200102-000000.sql.gz")
      expect(r.out).toContain("No backups left")
    } finally {
      delete process.env.BACKUP_RETENTION_DAYS
    }
  })
})
