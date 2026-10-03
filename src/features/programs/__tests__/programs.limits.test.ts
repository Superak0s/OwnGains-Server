import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import type { RowDataPacket } from "mysql2"
import { pool } from "../../../config/database.js"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { PROGRAM_LIMITS } from "../../../middleware/validation.js"

function day(dayNumber: number, exercises: Record<string, unknown>[] = []) {
  return {
    dayNumber,
    dayTitle: `Day ${dayNumber}`,
    exercises: [],
    split: { A: { exercises, totalSets: 0 } },
  }
}

const upload = (token: string, weeklyPlan: unknown) =>
  request(app)
    .post("/api/program/upload")
    .set(auth(token))
    .send({ originalFilename: "plan.xlsx", weeklyPlan })

describe("program upload limits", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("plim")
  })

  it("rejects oversized programs before touching the database", async () => {
    const tooManyDays = await upload(u.token, {
      split: ["A"],
      days: Array.from({ length: PROGRAM_LIMITS.days + 1 }, (_, i) => day(i + 1)),
    })
    expect(tooManyDays.status).toBe(400)

    const tooManyExercises = await upload(u.token, {
      split: ["A"],
      days: [
        day(
          1,
          Array.from({ length: PROGRAM_LIMITS.exercisesPerSplit + 1 }, (_, i) => ({
            name: `Ex ${i}`,
            sets: 3,
          })),
        ),
      ],
    })
    expect(tooManyExercises.status).toBe(400)

    const tooManySplits = await upload(u.token, {
      split: Array.from({ length: PROGRAM_LIMITS.splits + 1 }, (_, i) => `S${i}`),
      days: [day(1)],
    })
    expect(tooManySplits.status).toBe(400)

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id FROM programs WHERE user_id = ?`,
      [await internalId(u.user.id)],
    )
    expect(rows).toHaveLength(0)
  })

  it("400s on wrongly typed fields instead of 500ing", async () => {
    const cases: unknown[] = [
      { split: ["A"], days: [day(0)] },
      { split: ["A"], days: [day(1.5)] },
      { split: ["A"], days: [{ ...day(1), dayTitle: 42 }] },
      { split: ["A"], days: [day(1, [{ name: 7, sets: 3 }])] },
      { split: ["A"], days: [day(1, [{ name: "Row", sets: -1 }])] },
      { split: ["A"], days: [day(1, [{ name: "Row", sets: 3, reps: { x: 1 } }])] },
      { split: ["A"], days: [day(1, [{ name: "Row", sets: 3, exerciseId: 5 }])] },
      { split: ["A"], days: [day(1, [{ name: "Row", sets: 3, primaryMuscles: "back" }])] },
      { split: ["A"], days: [day(1, [{ name: "Row", sets: 3, machineMeta: [] }])] },
      { split: [1], days: [day(1)] },
      { split: ["A"], days: [{ ...day(1), split: [] }] },
      { split: ["A"], days: ["nope"] },
    ]
    for (const weeklyPlan of cases) {
      const res = await upload(u.token, weeklyPlan)
      expect(res.status, JSON.stringify(weeklyPlan)).toBe(400)
    }
  })

  it("stores a multi-day program in batched writes and echoes it back", async () => {
    const plan = {
      split: ["A", "B"],
      days: [1, 2, 3].map((n) => ({
        dayNumber: n,
        dayTitle: `Day ${n}`,
        exercises: [],
        split: {
          A: { exercises: [{ name: `Squat ${n}`, sets: 3, reps: 5 }], totalSets: 3 },
          B: { exercises: [{ name: "Row", sets: 2 }, { name: "Curl", sets: 4 }], totalSets: 6 },
        },
      })),
    }
    const first = await upload(u.token, plan)
    expect(first.status).toBe(200)
    expect(first.body.totalDays).toBe(3)
    expect(first.body.days).toHaveLength(3)

    const [before] = await pool.execute<RowDataPacket[]>(
      `SELECT pd.id, pd.day_number FROM program_days pd JOIN programs p ON p.id = pd.program_id
       WHERE p.user_id = ? ORDER BY pd.day_number`,
      [await internalId(u.user.id)],
    )

    // Re-upload two of the days: their rows (and so workout links) survive,
    // the dropped day goes.
    const second = await upload(u.token, { ...plan, days: plan.days.slice(0, 2) })
    expect(second.status).toBe(200)
    const [after] = await pool.execute<RowDataPacket[]>(
      `SELECT pd.id, pd.day_number FROM program_days pd JOIN programs p ON p.id = pd.program_id
       WHERE p.user_id = ? ORDER BY pd.day_number`,
      [await internalId(u.user.id)],
    )
    expect(after.map((r) => r.id)).toEqual(before.slice(0, 2).map((r) => r.id))

    const got = await request(app).get("/api/program").set(auth(u.token))
    expect(got.body.days).toHaveLength(2)
    expect(Object.keys(got.body.days[1].split)).toEqual(["A", "B"])
    expect(got.body.days[1].split.A.exercises[0]).toMatchObject({ name: "Squat 2", reps: "5" })
    expect(got.body.days[1].split.B.exercises.map((e: { name: string }) => e.name)).toEqual([
      "Row",
      "Curl",
    ])
  })

  it("caps a split's size and the split list on PATCH /exercise/add", async () => {
    const res = await upload(u.token, {
      split: ["A"],
      days: [
        day(
          1,
          Array.from({ length: PROGRAM_LIMITS.exercisesPerSplit }, (_, i) => ({
            name: `Full ${i}`,
            sets: 1,
          })),
        ),
      ],
    })
    expect(res.status).toBe(200)

    const full = await request(app)
      .patch("/api/program/exercise/add")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "A", exercise: { name: "One more", sets: 1 } })
    expect(full.status).toBe(400)

    for (let i = 1; i < PROGRAM_LIMITS.splits; i++) {
      const ok = await request(app)
        .patch("/api/program/exercise/add")
        .set(auth(u.token))
        .send({ dayNumber: 1, split: `X${i}`, exercise: { name: "Filler", sets: 1 } })
      expect(ok.status).toBe(200)
    }
    const overflow = await request(app)
      .patch("/api/program/exercise/add")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "Overflow", exercise: { name: "Filler", sets: 1 } })
    expect(overflow.status).toBe(400)
  })

  it("400s on wrongly typed PATCH fields", async () => {
    const bodies = [
      { dayNumber: { a: 1 }, split: "A", exerciseIndex: 0, newName: "X" },
      { dayNumber: 1, split: ["A"], exerciseIndex: 0, newName: "X" },
      { dayNumber: 1, split: "A", exerciseIndex: -1, newName: "X" },
      { dayNumber: 1, split: "A", exerciseIndex: 0, newName: 5 },
      { dayNumber: 1, split: "A", exerciseIndex: 0, newName: "X", newExerciseId: 3 },
    ]
    for (const body of bodies) {
      const res = await request(app)
        .patch("/api/program/exercise/rename")
        .set(auth(u.token))
        .send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    const hugeMeta = await request(app)
      .patch("/api/program/exercise/machine")
      .set(auth(u.token))
      .send({
        dayNumber: 1,
        split: "A",
        exerciseIndex: 0,
        patch: {
          machineMeta: Object.fromEntries(
            Array.from({ length: PROGRAM_LIMITS.machineMetaKeys + 1 }, (_, i) => [
              `M${i}`,
              { note: "n" },
            ]),
          ),
        },
      })
    expect(hugeMeta.status).toBe(400)
  })

  it("caps machineMeta across successive patches", async () => {
    const patch = (from: number, count: number) =>
      request(app)
        .patch("/api/program/exercise/machine")
        .set(auth(u.token))
        .send({
          dayNumber: 1,
          split: "A",
          exerciseIndex: 0,
          patch: {
            machineMeta: Object.fromEntries(
              Array.from({ length: count }, (_, i) => [`K${from + i}`, { setting: "3" }]),
            ),
          },
        })
    expect((await patch(0, PROGRAM_LIMITS.machineMetaKeys)).status).toBe(200)
    // Re-sending the same keys changes nothing and is fine.
    expect((await patch(0, 1)).status).toBe(200)
    expect((await patch(1000, 1)).status).toBe(400)
  })
})
