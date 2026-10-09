// Boot provisioning against a scratch database: database.ts is re-imported per
// case with the env it needs, and process.exit is stubbed so a failed boot is
// observable instead of fatal.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest"
import fs from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import mysql from "mysql2/promise"
import type { PoolConnection, RowDataPacket } from "mysql2/promise"

type Db = typeof import("../database.js")
// Its own database, since the fresh-install path needs an empty one. The dev
// MySQL user may create owngains_* databases only. TEST_PROV_DB_NAME overrides it.
const scratch = process.env.TEST_PROV_DB_NAME || "owngains_test_prov"
const saved = { ...process.env }
const pools: Db["pool"][] = []
let exit: ReturnType<typeof vi.spyOn>

async function admin<T>(fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({
    host: saved.DB_HOST,
    port: Number(saved.DB_PORT) || 3306,
    user: saved.DB_USER,
    password: saved.DB_PASSWORD,
  })
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function load(env: Record<string, string | undefined> = {}): Promise<Db> {
  vi.resetModules()
  process.env = { ...saved }
  process.env.DB_NAME = scratch
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const db = await import("../database.js")
  pools.push(db.pool)
  return db
}

const migrations = async (db: Db) => {
  const [rows] = await db.pool.query<RowDataPacket[]>("SELECT name FROM _migrations ORDER BY name")
  return rows.map((r) => r.name as string)
}

// Wraps every connection the pool hands out, so one statement can be faked.
function interceptConnections(db: Db, fake: (sql: string) => unknown) {
  const real = db.pool.getConnection.bind(db.pool)
  vi.spyOn(db.pool, "getConnection").mockImplementation(async () => {
    const c = await real()
    for (const m of ["query", "execute"] as const) {
      const orig = c[m].bind(c) as (...a: unknown[]) => unknown
      ;(c as unknown as Record<string, unknown>)[m] = (sql: string, ...a: unknown[]) => {
        const r = fake(sql)
        return r === undefined ? orig(sql, ...a) : r
      }
    }
    return c as PoolConnection
  })
}

// Skipped, not failed, where the MySQL user can't create a database.
const canCreate = await admin(async (c) => {
  try {
    await c.query(`DROP DATABASE IF EXISTS \`${scratch}\``)
    await c.query(`CREATE DATABASE \`${scratch}\``)
    await c.query(`DROP DATABASE \`${scratch}\``)
    return true
  } catch {
    return false
  }
})
beforeEach(() => {
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
})
afterEach(async () => {
  vi.restoreAllMocks()
  process.env = { ...saved }
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => {})))
})
afterAll(async () => {
  await admin((c) => c.query(`DROP DATABASE IF EXISTS \`${scratch}\``))
})

describe.skipIf(!canCreate)(`database provisioning (needs CREATE on ${scratch})`, () => {
  it("creates a fresh database, stamps every migration, then applies only unrecorded ones", async () => {
    // schema.sql never contains USE, but a hand-edited one must not switch databases.
    const read = fs.readFileSync
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      const text = read(p, o as BufferEncoding)
      return String(p).endsWith("schema.sql") ? `USE elsewhere;\n${text}` : text
    }) as typeof fs.readFileSync)

    let db = await load()
    await db.testDatabaseConnection()
    expect(exit).not.toHaveBeenCalled()
    const all = await migrations(db)
    expect(all.length).toBeGreaterThan(0)
    vi.restoreAllMocks()
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    // The column is already there, so the re-run's ER_DUP_FIELDNAME counts as done.
    await db.pool.query("DELETE FROM _migrations WHERE name = ?", [all[0]])
    db = await load({ DB_QUERY_TIMEOUT_MS: "0" })
    await db.testDatabaseConnection()
    expect(exit).not.toHaveBeenCalled()
    expect(await migrations(db)).toEqual(all)
  })

  it("names the migration that failed, and exits", async () => {
    const db = await load()
    const [last] = (await migrations(db)).slice(-1)
    await db.pool.query("DELETE FROM _migrations WHERE name = ?", [last])
    const read = fs.readFileSync
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) =>
      String(p).endsWith(last!) ? "FAIL_NO_CODE" : read(p, o as BufferEncoding)) as typeof fs.readFileSync)
    interceptConnections(db, (sql) => (sql === "FAIL_NO_CODE" ? Promise.reject(new Error("boom")) : undefined))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})

    await db.testDatabaseConnection()
    expect(exit).toHaveBeenCalledWith(1)
    expect(err.mock.calls.flat().join(" ")).toContain(`migration ${last} failed on "FAIL_NO_CODE": boom`)
  })

  it("gives up when another process holds the migration lock", async () => {
    const db = await load()
    interceptConnections(db, (sql) => (/GET_LOCK/.test(sql) ? Promise.resolve([[]]) : undefined))
    await db.testDatabaseConnection()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("fails without schema.sql, and skips migrations when their folder is missing", async () => {
    const exists = fs.existsSync
    const missing = { schema: true, migrations: false }
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const s = String(p)
      if (missing.schema && s.endsWith("schema.sql")) return false
      if (missing.migrations && s.endsWith("migrations")) return false
      return exists(p)
    })
    const db = await load()
    await db.testDatabaseConnection()
    expect(exit).toHaveBeenCalledWith(1)

    exit.mockClear()
    Object.assign(missing, { schema: false, migrations: true })
    await db.testDatabaseConnection()
    expect(exit).not.toHaveBeenCalled()
  })

  it("reads its connection settings from the environment", async () => {
    await expect(load({ DB_USER: undefined })).rejects.toThrow('"DB_USER" is not set')

    const ca = join(tmpdir(), `og-ca-${process.pid}.pem`)
    fs.writeFileSync(ca, "not a real certificate")
    try {
      await load({ DB_SSL_CA: ca })
    } finally {
      fs.unlinkSync(ca)
    }

    // localhost:3306 with TLS required: refused or rejected, either way a failed boot.
    const db = await load({ DB_SSL: "true", DB_HOST: undefined, DB_PORT: undefined })
    await db.testDatabaseConnection()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("logs, rather than throws, when a session setting fails, on MySQL or MariaDB", async () => {
    const db = await load()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onConnection = db.pool.listeners("connection")[0] as (c: unknown) => void
    const sent: string[] = []
    const query = (sql: string, cb: (e: Error) => void) => {
      sent.push(sql)
      cb(new Error("nope"))
    }
    onConnection({ query })
    // The pool may hand over a wrapper whose core connection carries the flag.
    onConnection({ query, connection: { _isMariaDB: true } })
    expect(sent).toContain("SET SESSION max_execution_time = 30000")
    expect(sent).toContain("SET SESSION max_statement_time = 30")
    expect(warn).toHaveBeenCalledTimes(6)
  })

  it("parseMySQLDate passes a Date through", async () => {
    const db = await load()
    const d = new Date()
    expect(db.parseMySQLDate(d)).toBe(d)
  })
})
