import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

const weeklyPlan = {
  split: ["push"],
  days: [
    {
      dayNumber: 1,
      dayTitle: "Push Day",
      exercises: [
        { name: "Bench Press", primaryMuscles: ["chest"], secondaryMuscles: [], setsBySplit: { push: 3 } },
      ],
      split: {
        push: { exercises: [{ name: "Bench Press", sets: 3 }], totalSets: 3 },
      },
    },
  ],
}

describe("programs routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("prog")
  })

  it("GET / 404s before an upload", async () => {
    expect((await request(app).get("/api/program").set(auth(u.token))).status).toBe(404)
  })

  it("POST /upload rejects malformed bodies", async () => {
    const noPlan = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ originalFilename: "plan.csv" })
    expect(noPlan.status).toBe(400)

    const noFile = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ weeklyPlan })
    expect(noFile.status).toBe(400)
  })

  it("uploads, retrieves, edits exercises, and deletes", async () => {
    const upload = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ weeklyPlan, originalFilename: "plan.csv" })
    expect(upload.status).toBe(200)
    expect(upload.body.totalDays).toBe(1)

    const got = await request(app).get("/api/program").set(auth(u.token))
    expect(got.status).toBe(200)
    expect(got.body.originalFilename).toBe("plan.csv")
    expect(got.body.days[0].dayNumber).toBe(1)

    const renameBad = await request(app)
      .patch("/api/program/exercise/rename")
      .set(auth(u.token))
      .send({ split: "push", exerciseIndex: 0 })
    expect(renameBad.status).toBe(400)

    const rename = await request(app)
      .patch("/api/program/exercise/rename")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exerciseIndex: 0, newName: "Bench" })
    expect(rename.status).toBe(200)

    const addBad = await request(app)
      .patch("/api/program/exercise/add")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exercise: {} })
    expect(addBad.status).toBe(400)

    const add = await request(app)
      .patch("/api/program/exercise/add")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exercise: { name: "Overhead Press", sets: 3 } })
    expect(add.status).toBe(200)
    expect(add.body.exercise.name).toBe("Overhead Press")

    const setsBad = await request(app)
      .patch("/api/program/exercise/sets")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exerciseIndex: 0 })
    expect(setsBad.status).toBe(400)

    const sets = await request(app)
      .patch("/api/program/exercise/sets")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exerciseIndex: 0, additionalSets: 2 })
    expect(sets.status).toBe(200)
    expect(sets.body.newSetCount).toBe(5)

    const del = await request(app).delete("/api/program").set(auth(u.token))
    expect(del.status).toBe(200)

    const gone = await request(app).get("/api/program").set(auth(u.token))
    expect(gone.status).toBe(404)
  })

  it("tracks the current day pointer", async () => {
    // Runs after the program was deleted above: no program reads as null, not
    // 404, and there is nothing to point a day at.
    const none = await request(app)
      .get("/api/program/current-day")
      .set(auth(u.token))
    expect(none.status).toBe(200)
    expect(none.body.currentDay).toBeNull()

    const orphan = await request(app)
      .put("/api/program/current-day")
      .set(auth(u.token))
      .send({ currentDay: 1 })
    expect(orphan.status).toBe(404)

    await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ weeklyPlan, originalFilename: "plan.csv" })

    const bad = await request(app)
      .put("/api/program/current-day")
      .set(auth(u.token))
      .send({ currentDay: 0 })
    expect(bad.status).toBe(400)

    // The day has to exist: this program has one day, so 3 points at nothing.
    // Pointing at it used to stick, and the client then started a workout for a
    // day the program didn't have.
    const noSuchDay = await request(app)
      .put("/api/program/current-day")
      .set(auth(u.token))
      .send({ currentDay: 3 })
    expect(noSuchDay.status).toBe(404)

    const set = await request(app)
      .put("/api/program/current-day")
      .set(auth(u.token))
      .send({ currentDay: 1 })
    expect(set.status).toBe(200)

    const read = await request(app)
      .get("/api/program/current-day")
      .set(auth(u.token))
    expect(read.body.currentDay).toBe(1)
    // GET / returns the same pointer.
    const program = await request(app).get("/api/program").set(auth(u.token))
    expect(program.body.currentDay).toBe(1)

    // Re-setting the same day is not "no such program": MySQL reports zero
    // changed rows for it.
    const same = await request(app)
      .put("/api/program/current-day")
      .set(auth(u.token))
      .send({ currentDay: 1 })
    expect(same.status).toBe(200)

    // A re-upload that drops the day the pointer names clears it, rather than
    // leaving it aimed past the end of a shrunk program.
    const shrunk = {
      split: ["push"],
      days: [{ ...weeklyPlan.days[0], dayNumber: 2 }],
    }
    await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ weeklyPlan: shrunk, originalFilename: "plan.csv" })
    const cleared = await request(app)
      .get("/api/program/current-day")
      .set(auth(u.token))
    expect(cleared.body.currentDay).toBeNull()
  })

  it("validates an upload instead of silently mangling it", async () => {
    const dayWith = (name: string, extra: Record<string, unknown> = {}) => ({
      dayNumber: 1,
      dayTitle: "Push Day",
      exercises: [],
      split: {
        push: {
          exercises: [{ name, sets: 3, ...extra }],
          totalSets: 3,
        },
      },
    })

    // exercises.name is utf8mb4_unicode_ci, so the catalog row comes back in
    // whatever spelling got there first. Keying the lookup on the payload's
    // spelling left it undefined and the whole upload 500'd on a casing
    // difference, including two casings inside one upload.
    const lower = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({
        weeklyPlan: { split: ["push"], days: [dayWith("case test press")] },
        originalFilename: "plan.csv",
      })
    expect(lower.status).toBe(200)

    const upper = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({
        weeklyPlan: { split: ["push"], days: [dayWith("Case Test Press")] },
        originalFilename: "plan.csv",
      })
    expect(upper.status).toBe(200)

    const bothCasings = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({
        weeklyPlan: {
          split: ["push"],
          days: [
            {
              ...dayWith("Case Test Press"),
              split: {
                push: {
                  exercises: [
                    { name: "Case Test Press", sets: 3 },
                    { name: "case test press", sets: 2 },
                  ],
                  totalSets: 5,
                },
              },
            },
          ],
        },
        originalFilename: "plan.csv",
      })
    expect(bothCasings.status).toBe(200)

    // Two entries for the same day upsert onto one row, and the second one's
    // wipe-and-rewrite emptied what the first had just written, with a 200.
    const dupeDay = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({
        weeklyPlan: {
          split: ["push"],
          days: [dayWith("Case Test Press"), { ...dayWith("Other"), split: {} }],
        },
        originalFilename: "plan.csv",
      })
    expect(dupeDay.status).toBe(400)

    // Unknown keys were dropped silently, so a client sending a field the
    // server had never heard of got a 200 and no data.
    const unknownKey = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({
        weeklyPlan: {
          split: ["push"],
          days: [dayWith("Case Test Press", { tempo: "3010" })],
        },
        originalFilename: "plan.csv",
      })
    expect(unknownKey.status).toBe(400)
    expect(unknownKey.body.error).toContain("tempo")
  })
})
