import { describe, it, expect } from "vitest"
import request from "supertest"
import type { RowDataPacket } from "mysql2"
import { app, signup, auth, befriend, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import { purgeExpiredProgramSnapshots } from "../programs.model.js"

const day = (n: number, exercise = "Squat") => ({
  dayNumber: n,
  dayTitle: `Day ${n}`,
  exercises: [],
  split: { A: { exercises: [{ name: exercise, sets: 3 }], totalSets: 3 } },
})
const plan = (...days: ReturnType<typeof day>[]) => ({
  originalFilename: "plan.xlsx",
  weeklyPlan: { split: ["A"], days },
})

/** A trainee with a two-day program and a trainer holding an active grant. */
async function pair() {
  const trainee = await signup("snte")
  const trainer = await signup("sntr")
  await befriend(trainee, trainer)
  const grant = await request(app)
    .post("/api/sharing/permissions")
    .set(auth(trainee.token))
    .send({ friendId: trainer.user.id, permissionType: "trainer" })
  expect(grant.status).toBe(201)
  const own = await request(app)
    .post("/api/program/upload")
    .set(auth(trainee.token))
    .send(plan(day(1), day(2, "Deadlift")))
  expect(own.status).toBe(200)
  const asTrainer = () => ({ ...auth(trainer.token), "X-Trainee-Id": trainee.user.id })
  return { trainee, trainer, asTrainer }
}

const snapshots = (token: string) =>
  request(app).get("/api/program/snapshots").set(auth(token))

describe("trainer program snapshots", () => {
  it("snapshots a trainer upload but not the trainee's own", async () => {
    const { trainee, asTrainer } = await pair()
    expect((await snapshots(trainee.token)).body.snapshots).toEqual([])

    const res = await request(app)
      .post("/api/program/upload")
      .set(asTrainer())
      .send(plan(day(1, "Lunge"), day(2, "Deadlift")))
    expect(res.status).toBe(200)
    expect(res.body.snapshotId).toEqual(expect.any(Number))
    expect(res.body.daysRemoved).toEqual([])

    const list = (await snapshots(trainee.token)).body.snapshots
    expect(list).toHaveLength(1)
    expect(list[0].trainer.uuid).toBeDefined()
    expect(new Date(list[0].expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000)
  })

  it("asks the trainer to confirm before removing days", async () => {
    const { trainee, asTrainer } = await pair()
    const refused = await request(app).post("/api/program/upload").set(asTrainer()).send(plan(day(1)))
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe("TRAINER_CONFIRM_REQUIRED")
    expect(refused.body.details.daysRemoved).toEqual([2])
    // Rolled back: no snapshot, day 2 still there.
    expect((await snapshots(trainee.token)).body.snapshots).toEqual([])
    expect((await request(app).get("/api/program").set(auth(trainee.token))).body.totalDays).toBe(2)

    const ok = await request(app)
      .post("/api/program/upload")
      .set(asTrainer())
      .send({ ...plan(day(1)), confirmRemoveDays: true })
    expect(ok.status).toBe(200)
    expect(ok.body.daysRemoved).toEqual([2])
    expect(ok.body.snapshotId).toEqual(expect.any(Number))
  })

  it("restores days, exercises and the day pointer, and relinks the unlinked workouts", async () => {
    const { trainee, asTrainer } = await pair()
    await request(app).put("/api/program/current-day").set(auth(trainee.token)).send({ currentDay: 2 })
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(trainee.token))
      .send({ dayNumber: 2, dayTitle: "Day 2" })
    const workoutId = start.body.session.id
    await request(app).post(`/api/sessions/${workoutId}/end`).set(auth(trainee.token)).send({})

    const up = await request(app)
      .post("/api/program/upload")
      .set(asTrainer())
      .send({ ...plan(day(1, "Lunge")), confirmRemoveDays: true })
    const linkOf = async () => {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT program_day_id AS d FROM workouts WHERE id = ?",
        [workoutId],
      )
      return rows[0].d
    }
    expect(await linkOf()).toBeNull()

    const restored = await request(app)
      .post(`/api/program/snapshots/${up.body.snapshotId}/restore`)
      .set(auth(trainee.token))
    expect(restored.status).toBe(200)
    expect(restored.body.totalDays).toBe(2)
    expect(restored.body.currentDay).toBe(2)
    expect(restored.body.days[0].split.A.exercises[0].name).toBe("Squat")
    expect(restored.body.days[1].split.A.exercises[0].name).toBe("Deadlift")
    expect(await linkOf()).not.toBeNull()

    // Restored ones leave the list and can't be restored twice.
    expect((await snapshots(trainee.token)).body.snapshots).toEqual([])
    expect(
      (await request(app).post(`/api/program/snapshots/${up.body.snapshotId}/restore`).set(auth(trainee.token))).status,
    ).toBe(404)
  })

  it("answers 403 to the trainer and 404 to anyone else", async () => {
    const { trainee, asTrainer } = await pair()
    const up = await request(app).post("/api/program/upload").set(asTrainer()).send(plan(day(1), day(2)))
    const id = up.body.snapshotId
    const stranger = await signup("snst")

    expect((await request(app).get("/api/program/snapshots").set(asTrainer())).status).toBe(403)
    expect((await request(app).post(`/api/program/snapshots/${id}/restore`).set(asTrainer())).status).toBe(403)
    expect((await request(app).delete(`/api/program/snapshots/${id}`).set(asTrainer())).status).toBe(403)

    expect((await snapshots(stranger.token)).body.snapshots).toEqual([])
    expect((await request(app).post(`/api/program/snapshots/${id}/restore`).set(auth(stranger.token))).status).toBe(404)
    expect((await request(app).delete(`/api/program/snapshots/${id}`).set(auth(stranger.token))).status).toBe(404)

    expect((await request(app).delete(`/api/program/snapshots/${id}`).set(auth(trainee.token))).status).toBe(200)
    expect((await snapshots(trainee.token)).body.snapshots).toEqual([])
  })

  it("expires after 7 days and the sweep deletes it", async () => {
    const { trainee, asTrainer } = await pair()
    const up = await request(app).post("/api/program/upload").set(asTrainer()).send(plan(day(1), day(2)))
    const id = up.body.snapshotId
    await pool.query("UPDATE program_snapshots SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?", [id])

    expect((await request(app).post(`/api/program/snapshots/${id}/restore`).set(auth(trainee.token))).status).toBe(404)
    await purgeExpiredProgramSnapshots()
    const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM program_snapshots WHERE id = ?", [id])
    expect(rows).toHaveLength(0)
  })

  it("keeps at most 10, dropping the oldest after the first", async () => {
    const { trainee, asTrainer } = await pair()
    const ids: number[] = []
    for (let i = 0; i < 11; i++) {
      const up = await request(app).post("/api/program/upload").set(asTrainer()).send(plan(day(1), day(2)))
      ids.push(up.body.snapshotId)
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM program_snapshots WHERE user_id = ? ORDER BY id",
      [await internalId(trainee.user.id)],
    )
    expect(rows.map((r) => r.id)).toEqual([ids[0], ...ids.slice(2)])
  })

  it("replays a restore with the same Idempotency-Key", async () => {
    const { trainee, asTrainer } = await pair()
    const up = await request(app).post("/api/program/upload").set(asTrainer()).send(plan(day(1, "Lunge"), day(2)))
    const send = () =>
      request(app)
        .post(`/api/program/snapshots/${up.body.snapshotId}/restore`)
        .set(auth(trainee.token))
        .set("Idempotency-Key", `restore-${up.body.snapshotId}`)
    const first = await send()
    const replay = await send()
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
  })
})
