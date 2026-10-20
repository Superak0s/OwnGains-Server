import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { pool } from "@/config/database.js"
import type { RowDataPacket } from "mysql2"

type User = Awaited<ReturnType<typeof signup>>

const start = "2030-03-04T17:30:00.000Z"

async function coach(trainee: User, trainer: User) {
  const req = await request(app).post("/api/friends/request").set(auth(trainee.token)).send({ username: trainer.username })
  await request(app).post(`/api/friends/request/${req.body.friendshipId}/accept`).set(auth(trainer.token))
  const grant = await request(app)
    .post("/api/sharing/permissions")
    .set(auth(trainee.token))
    .send({ friendId: trainer.user.id, permissionType: "trainer" })
  expect(grant.status).toBe(201)
}

const asTrainer = (trainer: User, trainee: User) => ({ ...auth(trainer.token), "X-Trainee-Id": trainee.user.id })
const list = async (headers: Record<string, string>) =>
  (await request(app).get("/api/schedule?from=2030-01-01T00:00:00Z&to=2030-12-31T00:00:00Z").set(headers)).body

describe("schedule routes", () => {
  it("creates, lists, edits and deletes the user's own workouts", async () => {
    const me = await signup("scha")

    expect((await request(app).post("/api/schedule").set(auth(me.token)).send({ startAt: start })).status).toBe(400)
    expect((await request(app).post("/api/schedule").set(auth(me.token)).send({ title: "Legs", startAt: "soon" })).status).toBe(400)
    expect(
      (await request(app).post("/api/schedule").set(auth(me.token)).send({ title: "Legs", startAt: start, durationMin: 2 })).status,
    ).toBe(400)

    const created = await request(app)
      .post("/api/schedule")
      .set(auth(me.token))
      .send({ title: " Legs ", startAt: start, programDay: 2, reminderMinutes: 30, alarm: true })
    expect(created.status).toBe(201)
    expect(created.body.scheduled).toMatchObject({
      title: "Legs",
      programDay: 2,
      startAt: start,
      durationMin: 60,
      reminderMinutes: 30,
      alarm: true,
      status: "accepted",
      scheduledBy: null,
    })
    const id = created.body.scheduled.id

    const patched = await request(app).patch(`/api/schedule/${id}`).set(auth(me.token)).send({ reminderMinutes: null })
    expect(patched.body.scheduled.reminderMinutes).toBeNull()
    expect((await list(auth(me.token))).scheduled).toHaveLength(1)
    expect(
      (await request(app).get("/api/schedule?from=2031-01-01T00:00:00Z&to=2030-01-01T00:00:00Z").set(auth(me.token))).status,
    ).toBe(400)

    const other = await signup("schb")
    expect((await request(app).patch(`/api/schedule/${id}`).set(auth(other.token)).send({ title: "x" })).status).toBe(404)

    expect((await request(app).delete(`/api/schedule/${id}`).set(auth(me.token))).status).toBe(200)
    expect((await list(auth(me.token))).scheduled).toHaveLength(0)
  })

  it("lets a trainer suggest a workout the client accepts, and never delete", async () => {
    const client = await signup("schc")
    const trainer = await signup("scht")
    const stranger = await signup("schs")
    await coach(client, trainer)

    expect(
      (await request(app).post("/api/schedule").set(asTrainer(stranger, client)).send({ title: "x", startAt: start })).status,
    ).toBe(403)

    const suggested = await request(app)
      .post("/api/schedule")
      .set(asTrainer(trainer, client))
      .send({ title: "Push", startAt: start })
    expect(suggested.status).toBe(201)
    expect(suggested.body.scheduled).toMatchObject({
      status: "pending",
      scheduledBy: { uuid: trainer.user.id, username: trainer.username },
    })
    const id = suggested.body.scheduled.id
    expect((await list(auth(client.token))).scheduled[0].status).toBe("pending")

    expect(
      (await request(app).patch(`/api/schedule/${id}`).set(asTrainer(trainer, client)).send({ accepted: true })).status,
    ).toBe(403)
    const accepted = await request(app).patch(`/api/schedule/${id}`).set(auth(client.token)).send({ accepted: true })
    expect(accepted.body.scheduled.status).toBe("accepted")

    const moved = await request(app)
      .patch(`/api/schedule/${id}`)
      .set(asTrainer(trainer, client))
      .send({ startAt: "2030-03-05T17:30:00.000Z" })
    expect(moved.body.scheduled.status).toBe("pending")

    const own = await request(app).post("/api/schedule").set(auth(client.token)).send({ title: "Mine", startAt: start })
    const ownId = own.body.scheduled.id
    expect(
      (await request(app).patch(`/api/schedule/${ownId}`).set(asTrainer(trainer, client)).send({ title: "x" })).body.code,
    ).toBe("NOT_YOUR_SUGGESTION")
    expect((await request(app).delete(`/api/schedule/${id}`).set(asTrainer(trainer, client))).status).toBe(403)

    const withdrawn = await request(app)
      .patch(`/api/schedule/${id}`)
      .set(asTrainer(trainer, client))
      .send({ cancelled: true })
    expect(withdrawn.status).toBe(200)
    expect((await list(auth(client.token))).scheduled.map((s: { id: number }) => s.id)).toEqual([ownId])
    const withCancelled = await request(app)
      .get("/api/schedule?from=2030-01-01T00:00:00Z&to=2030-12-31T00:00:00Z&includeCancelled=1")
      .set(auth(client.token))
    expect(withCancelled.body.scheduled.map((s: { id: number; status: string }) => [s.id, s.status])).toEqual(
      expect.arrayContaining([[id, "cancelled"], [ownId, "accepted"]]),
    )
    expect((await request(app).patch(`/api/schedule/${id}`).set(auth(client.token)).send({ accepted: true })).status).toBe(404)

    await request(app).post("/api/schedule").set(asTrainer(trainer, client)).send({ title: "Pull", startAt: start })
    await request(app).delete("/api/auth/account/data").set(auth(trainer.token)).send({ confirmDelete: "DELETE_ALL_DATA", password: trainer.password }).expect(200)
    expect((await list(auth(client.token))).scheduled).toHaveLength(2)
  })

  it("is removed with the account", async () => {
    const me = await signup("schd")
    await request(app).post("/api/schedule").set(auth(me.token)).send({ title: "Legs", startAt: start })
    const id = await internalId(me.user.id)
    expect((await request(app).delete("/api/auth/account").set(auth(me.token)).send({ password: me.password })).status).toBe(200)
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT 1 FROM scheduled_workouts WHERE user_id = ?",
      [id],
    )
    expect(rows).toHaveLength(0)
  })
})
