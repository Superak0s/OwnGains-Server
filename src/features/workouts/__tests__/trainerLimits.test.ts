import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

// The trainer grant is additive. These cover the routes that remain open to a
// trainer but must not be able to destroy the trainee's data through them.
describe("trainer mode limits", () => {
  let trainee: Awaited<ReturnType<typeof signup>>
  let trainer: Awaited<ReturnType<typeof signup>>
  const asTrainer = () => ({ ...auth(trainer.token), "X-Trainee-Id": trainee.user.id })

  beforeAll(async () => {
    trainee = await signup("tlee")
    trainer = await signup("tler")
    const fr = await request(app)
      .post("/api/friends/request")
      .set(auth(trainee.token))
      .send({ username: trainer.username })
    await request(app)
      .post(`/api/friends/request/${fr.body.friendshipId}/accept`)
      .set(auth(trainer.token))
    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainer.user.id, permissionType: "trainer" })
    expect(grant.status).toBe(201)

    const upload = await request(app)
      .post("/api/program/upload")
      .set(auth(trainee.token))
      .send({
        originalFilename: "plan.xlsx",
        weeklyPlan: {
          split: ["A"],
          days: [
            {
              dayNumber: 1,
              dayTitle: "Day 1",
              exercises: [],
              split: {
                A: {
                  exercises: [
                    {
                      name: "Leg Press",
                      sets: 3,
                      machines: ["Sled"],
                      machineMeta: { Sled: { setting: "7" } },
                    },
                  ],
                  totalSets: 3,
                },
              },
            },
          ],
        },
      })
    expect(upload.status).toBe(200)
  })

  it("lets a trainer add sets but not remove them", async () => {
    const add = await request(app)
      .patch("/api/program/exercise/sets")
      .set(asTrainer())
      .send({ dayNumber: 1, split: "A", exerciseIndex: 0, additionalSets: 1 })
    expect(add.status).toBe(200)
    expect(add.body.newSetCount).toBe(4)

    const remove = await request(app)
      .patch("/api/program/exercise/sets")
      .set(asTrainer())
      .send({ dayNumber: 1, split: "A", exerciseIndex: 0, additionalSets: -4 })
    expect(remove.status).toBe(403)
    expect(remove.body.code).toBe("TRAINER_DESTRUCTIVE_EDIT")

    // The trainee can.
    const own = await request(app)
      .patch("/api/program/exercise/sets")
      .set(auth(trainee.token))
      .send({ dayNumber: 1, split: "A", exerciseIndex: 0, additionalSets: -1 })
    expect(own.status).toBe(200)
  })

  it("refuses machine patches that clear settings in trainer mode", async () => {
    for (const patch of [
      { machineMeta: null },
      { machineMeta: { Sled: null } },
      { selectedMachine: null },
    ]) {
      const res = await request(app)
        .patch("/api/program/exercise/machine")
        .set(asTrainer())
        .send({ dayNumber: 1, split: "A", exerciseIndex: 0, patch })
      expect(res.status, JSON.stringify(patch)).toBe(403)
    }
    const additive = await request(app)
      .patch("/api/program/exercise/machine")
      .set(asTrainer())
      .send({ dayNumber: 1, split: "A", exerciseIndex: 0, patch: { machineMeta: { Sled: { note: "hi" } } } })
    expect(additive.status).toBe(200)

    const program = await request(app).get("/api/program").set(auth(trainee.token))
    expect(program.body.days[0].split.A.exercises[0].machineMeta).toEqual({
      Sled: { setting: "7", note: "hi" },
    })
  })

  it("lets a trainer edit sets only while the workout is in progress", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(asTrainer())
      .send({ dayNumber: 1, dayTitle: "Day 1" })
    const sessionId = start.body.session.id
    const set = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(asTrainer())
      .send({
        exerciseName: "Leg Press",
        setIndex: 0,
        startTime: new Date(Date.now() - 60_000).toISOString(),
        endTime: new Date().toISOString(),
        weight: 100,
        reps: 10,
      })
    expect(set.status).toBe(200)
    const setId = set.body.timing.id

    const openEdit = await request(app)
      .patch(`/api/sessions/${sessionId}/sets/${setId}`)
      .set(asTrainer())
      .send({ weight: 110 })
    expect(openEdit.status).toBe(200)

    await request(app).post(`/api/sessions/${sessionId}/end`).set(auth(trainee.token)).send({})

    const closedEdit = await request(app)
      .patch(`/api/sessions/${sessionId}/sets/${setId}`)
      .set(asTrainer())
      .send({ weight: 0 })
    expect(closedEdit.status).toBe(403)
    expect(closedEdit.body.code).toBe("TRAINER_WORKOUT_ENDED")

    const ownEdit = await request(app)
      .patch(`/api/sessions/${sessionId}/sets/${setId}`)
      .set(auth(trainee.token))
      .send({ weight: 105 })
    expect(ownEdit.status).toBe(200)
    expect(ownEdit.body.timing.weight).toBe(105)
  })

  it("keeps the trainer's Idempotency-Keys apart from the trainee's", async () => {
    const key = `shared-${Date.now()}`
    const body = { dayNumber: 1, dayTitle: "Day 1", split: `idem${Date.now()}` }
    const own = await request(app)
      .post("/api/sessions/start")
      .set(auth(trainee.token))
      .set("Idempotency-Key", key)
      .send(body)
    expect(own.status).toBe(200)

    // Same key and body from the trainer is a different request, not a replay
    // of the trainee's.
    const asCoach = await request(app)
      .post("/api/sessions/start")
      .set(asTrainer())
      .set("Idempotency-Key", key)
      .send(body)
    expect(asCoach.status).toBe(200)
    expect(asCoach.body.session.id).not.toBe(own.body.session.id)

    const replay = await request(app)
      .post("/api/sessions/start")
      .set(asTrainer())
      .set("Idempotency-Key", key)
      .send(body)
    expect(replay.text).toBe(asCoach.text)

    for (const id of [own.body.session.id, asCoach.body.session.id])
      await request(app).post(`/api/sessions/${id}/end`).set(auth(trainee.token)).send({})
  })
})
