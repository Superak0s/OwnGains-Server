import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { pool } from "@/config/database.js"

const send = (token: string, body: object) =>
  request(app).post("/api/trainer/requests").set(auth(token)).send(body)

describe("trainer routes", () => {
  it("request, accept, act as, list clients, and tag the session", async () => {
    const coach = await signup("coach")
    const maria = await signup("maria")

    expect((await send(coach.token, { toUsername: coach.username, includeTracking: false })).status).toBe(400)
    expect((await send(coach.token, { includeTracking: false })).status).toBe(400)
    expect((await send(coach.token, { toUsername: maria.username })).status).toBe(400)
    expect((await send(coach.token, { toUsername: "nosuchuser", includeTracking: false })).status).toBe(404)

    const sent = await send(coach.token, { toUserId: maria.user.id, includeTracking: false })
    expect(sent.status).toBe(201)
    const r = sent.body.data.request
    expect(r).toMatchObject({
      fromUserId: coach.user.id,
      fromUsername: coach.username,
      toUserId: maria.user.id,
      toUsername: maria.username,
      includeTracking: false,
    })
    expect(typeof r.id).toBe("string")
    expect((await send(coach.token, { toUsername: maria.username, includeTracking: false })).status).toBe(409)

    const received = await request(app).get("/api/trainer/requests/received").set(auth(maria.token))
    expect(received.body.data.requests.map((x: { id: string }) => x.id)).toEqual([r.id])
    const out = await request(app).get("/api/trainer/requests/sent").set(auth(coach.token))
    expect(out.body.data.requests.map((x: { id: string }) => x.id)).toEqual([r.id])

    // Only the recipient can accept.
    expect(
      (await request(app).post(`/api/trainer/requests/${r.id}/accept`).set(auth(coach.token)).send({ includeTracking: false })).status,
    ).toBe(404)
    const accepted = await request(app)
      .post(`/api/trainer/requests/${r.id}/accept`)
      .set(auth(maria.token))
      .send({ includeTracking: false })
    expect(accepted.body).toEqual({ success: true })
    expect((await request(app).get("/api/trainer/requests/received").set(auth(maria.token))).body.data.requests).toEqual([])
    expect((await send(coach.token, { toUsername: maria.username, includeTracking: false })).status).toBe(409)

    // Maria logs one on her own, coach logs one as her.
    const own = await request(app)
      .post("/api/sessions/start")
      .set(auth(maria.token))
      .send({ dayNumber: 1, dayTitle: "Push" })
    await request(app).post(`/api/sessions/${own.body.session.id}/end`).set(auth(maria.token)).send({})
    const coached = await request(app)
      .post("/api/sessions/start")
      .set(auth(coach.token))
      .set("X-Trainee-Id", maria.user.id)
      .send({ dayNumber: 2, dayTitle: "Pull" })
    expect(coached.status).toBe(200)
    await request(app)
      .post(`/api/sessions/${coached.body.session.id}/end`)
      .set(auth(coach.token))
      .set("X-Trainee-Id", maria.user.id)
      .send({})

    expect((await request(app).get("/api/trainer/clients?weekStart=2026-02-31").set(auth(coach.token))).status).toBe(400)
    const clients = await request(app).get("/api/trainer/clients?weekStart=2000-01-03").set(auth(coach.token))
    expect(clients.status).toBe(200)
    expect(clients.body.data.clients).toEqual([
      {
        userId: maria.user.id,
        username: maria.username,
        lastWorkoutAt: expect.stringMatching(/Z$/),
        sessionsThisWeek: 2,
        activeProgramDayCount: null,
        hasTrackingAccess: false,
      },
    ])
    const future = await request(app).get("/api/trainer/clients?weekStart=2999-01-07").set(auth(coach.token))
    expect(future.body.data.clients[0].sessionsThisWeek).toBe(0)

    // History needs its own grant, then shows who logged what.
    const perm = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(maria.token))
      .send({ friendId: coach.user.id, permissionType: "history" })
    expect(perm.status).toBe(201)
    const hist = await request(app).get(`/api/sharing/sessions/friend/${maria.user.id}`).set(auth(coach.token))
    const byId = new Map(hist.body.sessions.map((s: { id: number; loggedByTrainerId: string | null }) => [s.id, s.loggedByTrainerId]))
    expect(byId.get(own.body.session.id)).toBeNull()
    expect(byId.get(coached.body.session.id)).toBe(coach.user.id)
    const detail = await request(app)
      .get(`/api/sharing/sessions/friend/${maria.user.id}/${coached.body.session.id}`)
      .set(auth(coach.token))
    expect(detail.body.session.loggedByTrainerId).toBe(coach.user.id)
    expect(detail.body.session.loggedByTrainerUsername).toBe(coach.username)

    // The client's own history names the trainer too.
    const ownHist = await request(app).get("/api/sessions").set(auth(maria.token))
    const mineById = new Map(ownHist.body.sessions.map((s: { id: number; loggedByTrainerUsername: string | null }) => [s.id, s.loggedByTrainerUsername]))
    expect(mineById.get(own.body.session.id)).toBeNull()
    expect(mineById.get(coached.body.session.id)).toBe(coach.username)
    const mineDetail = await request(app).get(`/api/sessions/${coached.body.session.id}`).set(auth(maria.token))
    expect(mineDetail.body.session.loggedByTrainerId).toBe(coach.user.id)

    // The trainer's export and wipe leave the client's workouts alone.
    const exp = await request(app).get("/api/auth/account/export").set(auth(coach.token))
    expect(exp.body.data.workouts ?? []).toHaveLength(0)
    await request(app).delete("/api/auth/account/data").set(auth(coach.token)).send({ confirmDelete: "DELETE_ALL_DATA", password: coach.password }).expect(200)
    const mine = await request(app).get("/api/sessions").set(auth(maria.token))
    expect(mine.body.sessions).toHaveLength(2)
  })

  it("lets a current trainer ask for Tracking Access on its own", async () => {
    const coach = await signup("tcoach")
    const ana = await signup("tana")
    const accept = (id: string, includeTracking: boolean) =>
      request(app).post(`/api/trainer/requests/${id}/accept`).set(auth(ana.token)).send({ includeTracking })
    const first = await send(coach.token, { toUserId: ana.user.id, includeTracking: true })
    await accept(first.body.data.request.id, false).expect(200)
    const clients = async () =>
      (await request(app).get("/api/trainer/clients?weekStart=2026-01-05").set(auth(coach.token))).body.data.clients
    expect((await clients())[0].hasTrackingAccess).toBe(false)

    const ask = await send(coach.token, { toUserId: ana.user.id, includeTracking: true })
    expect(ask.status).toBe(201)
    await accept(ask.body.data.request.id, true).expect(200)
    expect((await clients())[0].hasTrackingAccess).toBe(true)
    expect((await send(coach.token, { toUserId: ana.user.id, includeTracking: true })).status).toBe(409)
  })

  it("reject deletes the request, and a block refuses a new one", async () => {
    const coach = await signup("coach")
    const sam = await signup("sam")
    const r = (await send(coach.token, { toUsername: sam.username, includeTracking: false })).body.data.request
    expect((await request(app).post(`/api/trainer/requests/${r.id}/reject`).set(auth(coach.token))).status).toBe(404)
    expect((await request(app).post(`/api/trainer/requests/${r.id}/reject`).set(auth(sam.token))).body).toEqual({ success: true })
    expect((await request(app).post(`/api/trainer/requests/${r.id}/reject`).set(auth(sam.token))).status).toBe(404)

    await request(app).post(`/api/friends/block/${coach.user.id}`).set(auth(sam.token))
    expect((await send(coach.token, { toUsername: sam.username, includeTracking: false })).status).toBe(403)
  })

  it("lets the sender cancel a request and a trainer drop a client", async () => {
    const coach = await signup("coachx")
    const kim = await signup("kim")
    const r = (await send(coach.token, { toUsername: kim.username, includeTracking: true })).body.data.request
    expect((await request(app).delete("/api/trainer/requests/abc").set(auth(coach.token))).status).toBe(400)
    expect((await request(app).delete(`/api/trainer/requests/${r.id}`).set(auth(kim.token))).status).toBe(404)
    expect((await request(app).delete(`/api/trainer/requests/${r.id}`).set(auth(coach.token))).body).toEqual({ success: true })
    expect((await request(app).delete(`/api/trainer/requests/${r.id}`).set(auth(coach.token))).status).toBe(404)

    const again = (await send(coach.token, { toUsername: kim.username, includeTracking: true })).body.data.request
    await request(app).post(`/api/trainer/requests/${again.id}/accept`).set(auth(kim.token)).send({ includeTracking: true })
    const clients = () => request(app).get("/api/trainer/clients?weekStart=2026-01-05").set(auth(coach.token))
    expect((await clients()).body.data.clients).toHaveLength(1)

    expect((await request(app).delete("/api/trainer/clients/not-a-uuid").set(auth(coach.token))).status).toBe(400)
    expect((await request(app).delete(`/api/trainer/clients/${coach.user.id}`).set(auth(kim.token))).status).toBe(404)
    expect((await request(app).delete(`/api/trainer/clients/${kim.user.id}`).set(auth(coach.token))).body).toEqual({ success: true })
    expect((await clients()).body.data.clients).toHaveLength(0)
    const [left] = await pool.execute("SELECT permission_type FROM sharing_permissions WHERE from_user_id = ?", [
      await internalId(kim.user.id),
    ])
    expect(left).toEqual([])
    expect((await request(app).delete(`/api/trainer/clients/${kim.user.id}`).set(auth(coach.token))).status).toBe(404)
  })
})
