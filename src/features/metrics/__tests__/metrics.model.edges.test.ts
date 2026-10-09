// The DB snapshot when parts of it fail or come back empty, and pool stats
// when mysql2's internals are missing. Its own file for a cold snapshot cache.
import { describe, it, expect, vi } from "vitest"
import { pool } from "../../../config/database.js"
import { getDbSnapshot, poolStats } from "../metrics.model.js"

describe("metrics model edges", () => {
  it("reports each failed part, and an empty version and a null status value", async () => {
    vi.spyOn(pool, "query").mockImplementation((async (sql: string) => {
      if (sql.includes("VERSION()")) return [[]]
      if (sql.includes("SHOW GLOBAL STATUS")) return [[{ Variable_name: "Questions", Value: null }]]
      if (sql.includes("information_schema")) throw new Error("no access")
      throw "plain string"
    }) as never)
    const snap = await getDbSnapshot()
    vi.restoreAllMocks()
    expect(snap).toMatchObject({ app: null, size: null, server: { version: null, status: { Questions: 0 } } })
    expect(snap.errors).toEqual(["app counts: plain string", "table sizes: no access"])
  })

  it("reports nulls when the pool's internals aren't there", () => {
    const p = pool as unknown as { pool: unknown }
    const core = p.pool
    p.pool = undefined
    try {
      expect(poolStats()).toEqual({ limit: null, queueLimit: null, open: null, inUse: null, queued: null })
    } finally {
      p.pool = core
    }
  })
})
