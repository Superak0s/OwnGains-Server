// Model-level checks the routes' own validators normally stop first, called
// directly: the body-fat formula, injury edits, measurement caps and retries,
// and the health-data purge and its dry run.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import type { PoolConnection } from "mysql2/promise"
import { signup, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import { calculateBodyFatPercentage } from "../bodyStats/bodyStats.model.js"
import { logInjury, updateInjury } from "../injury/injury.model.js"
import * as m from "../measurements/measurements.model.js"
import { countHealthData, deleteHealthData } from "../healthConsent.js"
import * as mc from "../menstrual/menstrual.model.js"
import * as so from "../soreness/soreness.model.js"

afterEach(() => vi.restoreAllMocks())

let userId: number
beforeAll(async () => {
  userId = await internalId((await signup("trkedge")).user.id)
})

describe("body fat formula", () => {
  it.each<[string, "male" | "female", number, number, number, number | null, string]>([
    ["no height", "male", 0, 80, 40, null, "Invalid height"],
    ["no waist", "male", 180, 0, 40, null, "Invalid waist"],
    ["no neck", "male", 180, 80, 0, null, "Invalid neck"],
    ["neck over waist", "male", 180, 40, 50, null, "Waist must be greater than neck"],
    ["no hip", "female", 170, 70, 35, null, "Hip measurement required"],
    ["neck over waist plus hip", "female", 170, 1, 500, 1, "Waist + Hip must be greater"],
    ["impossible result", "male", 300, 41, 40, null, "Invalid body fat result"],
  ])("rejects %s", (_n, sex, h, w, n, hip, message) => {
    expect(() => calculateBodyFatPercentage(sex, h, w, n, hip)).toThrow(message)
  })

  it("computes the female formula", () => {
    expect(calculateBodyFatPercentage("female", 165, 75, 33, 100)).toBe(29.4)
  })
})

describe("injuries", () => {
  it("rejects a bad type or pain level, and defaults the start date", async () => {
    await expect(logInjury(userId, "back", "nope" as never, 3, "")).rejects.toThrow("Invalid injury type")
    await expect(logInjury(userId, "back", "strain", 11, "")).rejects.toThrow("Pain level")
    expect((await logInjury(userId, "back", "strain", 3, "")).startDate).toBeTruthy()
  })

  it("edits status, recovery date and note, and rejects what it can't store", async () => {
    const { id } = await logInjury(userId, "knee", "strain", 4, "2026-03-10")
    await expect(updateInjury(userId, id, {})).rejects.toThrow("No valid fields")
    await expect(updateInjury(userId, id, { status: "gone" as never })).rejects.toThrow("Invalid status")
    await expect(updateInjury(userId, id, { recoveryDate: "2026-03-01" })).rejects.toThrow("before start date")
    await expect(updateInjury(userId, 999_999_999, { note: "x" })).rejects.toThrow("Injury")
    expect(await updateInjury(userId, id, { status: "recovered", recoveryDate: "2026-03-20", note: "ok" })).toMatchObject({
      status: "recovered",
      note: "ok",
    })
    expect((await updateInjury(userId, id, { recoveryDate: null, note: null })).recoveryDate).toBeNull()
  })
})

describe("measurements", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, "weight_kg"]))

  it("rejects empty, oversized and non-positive entries", async () => {
    await expect(m.logMetrics(userId, [])).rejects.toThrow("At least one")
    await expect(m.logMetrics(userId, Array(21).fill({ metric: "chest_cm", value: 90 }))).rejects.toThrow("At most 20")
    await expect(m.logMetrics(userId, [{ metric: "chest_cm", value: 0 }])).rejects.toThrow("chest_cm must be a number")
  })

  it("caps the metrics one read, delete or check may name", async () => {
    await expect(m.getMetricGroups(userId, many(11), 1)).rejects.toThrow("At most 10")
    await expect(m.getMetricGroups(userId, { w: "weight_kg" }, 1, "chest_cm")).rejects.toThrow("not in the pivot")
    await expect(m.deleteMetricGroup(userId, 1, Array(11).fill("weight_kg"))).rejects.toThrow("At most 10")
    const custom = Array.from({ length: 21 }, (_, i) => `custom_${i}`)
    await expect(m.requireKnownMetrics(userId, custom)).rejects.toThrow("At most 20")
  })

  it("has no latest value for a metric never logged", async () => {
    expect(await m.getLatestMetric(userId, "arm_left_cm")).toBeNull()
  })

  it("checks a new metric definition", async () => {
    await expect(m.createMetricDefinition(userId, "", "L")).rejects.toThrow("keyName and label")
    await expect(m.createMetricDefinition(userId, "weight_kg", "W")).rejects.toThrow("built-in")
  })

  it("rethrows a definition insert that fails for any reason but a duplicate", async () => {
    const real = pool.execute.bind(pool)
    vi.spyOn(pool, "execute").mockImplementation(((sql: string, p: unknown) =>
      sql.startsWith("INSERT INTO metric_definitions")
        ? Promise.reject(Object.assign(new Error("disk full"), { errno: 1021 }))
        : real(sql, p as never)) as never)
    await expect(m.createMetricDefinition(userId, "grip_kg", "Grip")).rejects.toThrow("disk full")
  })

  it("retries an additive insert on a duplicate seq or deadlock, up to three times", async () => {
    const real = pool.execute.bind(pool)
    let fails = 0
    const failWith = (errno: number, times: number) => {
      fails = 0
      vi.spyOn(pool, "execute").mockImplementation(((sql: string, p: unknown) =>
        sql.includes("COALESCE(MAX(entry_seq)") && fails++ < times
          ? Promise.reject(Object.assign(new Error(`errno ${errno}`), { errno }))
          : real(sql, p as never)) as never)
    }
    failWith(1062, 1)
    expect(await m.logMetrics(userId, [{ metric: "water_ml", value: 250 }])).toBeGreaterThan(0)
    failWith(1213, 4)
    await expect(m.logMetrics(userId, [{ metric: "water_ml", value: 250 }])).rejects.toThrow("errno 1213")
    failWith(1205, 1)
    await expect(m.logMetrics(userId, [{ metric: "water_ml", value: 250 }])).rejects.toThrow("errno 1205")
  })
})

describe("health data purge", () => {
  it("counts every table, with and without tracking", async () => {
    expect(Object.keys(await countHealthData(["tracking"]))).toContain("users (height, sex)")
    expect(Object.keys(await countHealthData(["supplements"]))).not.toContain("users (height, sex)")
  })

  it("deletes for one user, and builds the everyone statements without a user filter", async () => {
    expect(await deleteHealthData(userId, ["supplements"])).not.toHaveProperty(["users (height, sex)"])

    // Everyone's data, so the statements are captured rather than run: other
    // test files share this database.
    const conn = await pool.getConnection()
    const seen: string[] = []
    vi.spyOn(conn, "execute").mockImplementation((async (sql: string, params: unknown[]) => {
      seen.push(`${sql.replaceAll(/\s+/g, " ").trim()} ${JSON.stringify(params)}`)
      return [{ affectedRows: 0 }]
    }) as never)
    vi.spyOn(pool, "getConnection").mockResolvedValueOnce(conn as PoolConnection)
    await deleteHealthData(null)
    expect(seen.every((s) => s.endsWith("[]") && !s.includes("user_id = ?") && !s.includes("id = ?"))).toBe(true)
    expect(seen.some((s) => s.startsWith("UPDATE users"))).toBe(true)
  })
})

describe("menstrual cycles", () => {
  it("rejects a bad start, and edits an entry's end and symptoms", async () => {
    await expect(mc.logMenstrualCycle(userId, "not a date")).rejects.toThrow("Invalid cycle start date")
    const { id } = await mc.logMenstrualCycle(userId, "2026-02-01T00:00:00Z", [])
    await expect(mc.updateMenstrualCycle(userId, id, {})).rejects.toThrow("No valid fields")
    await expect(mc.updateMenstrualCycle(userId, 999_999_999, { cycleEnd: null })).rejects.toThrow("Menstrual entry")
    await expect(mc.updateMenstrualCycle(userId, id, { cycleEnd: "2026-01-01T00:00:00Z" })).rejects.toThrow(
      "Cycle end cannot be before cycle start",
    )
    expect(await mc.updateMenstrualCycle(userId, id, { cycleEnd: "2026-02-05T00:00:00Z", symptoms: ["cramps"] })).toMatchObject({
      symptoms: ["cramps"],
    })
    expect((await mc.updateMenstrualCycle(userId, id, { cycleEnd: null })).cycleEnd).toBeNull()
  })

  it("has no phase without a cycle, and the period phase on its first day", async () => {
    const fresh = await internalId((await signup("mcfresh")).user.id)
    expect(await mc.getCycleStats(fresh)).toMatchObject({ currentPhase: null, lastCycleEntry: null })
    await mc.logMenstrualCycle(fresh, new Date().toISOString())
    expect((await mc.getCycleStats(fresh)).currentPhase).toMatchObject({ phase: "menstruation", daysInPhase: 0 })
  })
})

describe("soreness", () => {
  it.each([null, "x".repeat(51), "bad<tag>"])("rejects the muscle %s", async (muscle) => {
    await expect(so.logSoreness(userId, muscle as never, 3)).rejects.toThrow("Invalid muscle group")
  })

  it("rejects a bad status and an oversized batch, and does nothing for an empty or unowned one", async () => {
    const { id } = await so.logSoreness(userId, "IT band", 3)
    await expect(so.addFollowUp(userId, id, 2, "gone" as never)).rejects.toThrow("Invalid status")
    const item = { sorenessId: id, intensity: 1, status: "better" as const }
    await expect(so.batchFollowUp(userId, Array(51).fill(item))).rejects.toThrow("Too many updates")
    expect(await so.batchFollowUp(userId, [])).toEqual({ entries: [], skipped: [] })
    expect(await so.batchFollowUp(userId, [{ ...item, sorenessId: 999_999_999 }])).toEqual({ entries: [], skipped: [999_999_999] })
  })
})
