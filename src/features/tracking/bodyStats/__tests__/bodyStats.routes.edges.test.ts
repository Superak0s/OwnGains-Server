// Tape-measurement checks on POST /bodyfat/log the main suite doesn't reach.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import request from "supertest"
import { pool } from "../../../../config/database.js"
import { logger } from "../../../../utils/logger.js"
import { calculateBodyFatPercentage } from "../bodyStats.model.js"
import { app, signup, auth } from "../../../../tests/helpers.js"

afterEach(() => vi.restoreAllMocks())

const log = (token: string, body: object) =>
  request(app).post("/api/tracking/bodystats/bodyfat/log").set(auth(token)).send(body)

describe("bodyfat log tape checks", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let noHeight: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("bsedge")
    noHeight = await signup("bsnoh")
    await pool.execute("UPDATE users SET height_cm = 180, bf_formula_sex = 'male' WHERE uuid = ?", [u.user.id])
  })

  it.each<[string, object, string]>([
    ["no waist", { percentage: 15, measurements: { neck: 38 } }, "Invalid waist"],
    ["no neck", { percentage: 15, measurements: { waist: 80 } }, "Invalid neck"],
    ["female without hip", { percentage: 25, bfFormulaSex: "female", measurements: { waist: 80, neck: 33 } }, "Invalid hip"],
    ["unknown sex", { percentage: 15, bfFormulaSex: "x", measurements: { waist: 80, neck: 38 } }, "bfFormulaSex must be"],
  ])("rejects %s", async (_n, body, message) => {
    const res = await log(u.token, body)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain(message)
  })

  it("converts inches, and warns on a percentage that doesn't match", async () => {
    const warn = vi.spyOn(logger, "warn")
    const res = await log(u.token, {
      percentage: 60,
      bfFormulaSex: "female",
      measurements: { waist: 30, neck: 13, hip: 38, unit: "in" },
    })
    expect(res.status).toBe(201)
    expect(res.body.entry.measurements.hip).toBeCloseTo(96.52)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Body fat calculation mismatch"))
  })

  it("logs a matching percentage without a warning", async () => {
    const warn = vi.spyOn(logger, "warn")
    const percentage = calculateBodyFatPercentage("male", 180, 80, 38, null)
    expect((await log(u.token, { percentage, measurements: { waist: 80, neck: 38 } })).status).toBe(201)
    expect(warn).not.toHaveBeenCalled()
  })

  it("skips the cross-check for a profile without a height", async () => {
    const res = await log(noHeight.token, { percentage: 18, measurements: { waist: 80, neck: 38 } })
    expect(res.status).toBe(201)
    expect(res.body.entry.measurements.hip).toBeNull()
  })
})
