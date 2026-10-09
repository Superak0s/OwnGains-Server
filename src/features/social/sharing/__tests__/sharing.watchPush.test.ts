// watch_progress pushes to friends polling /live, with the WS layer mocked so
// every sendToUser call can be inspected. Mock calls reset between tests.
import { describe, it, expect, beforeAll, vi } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../../tests/helpers.js"
import { sendFriendRequest, acceptFriendRequest } from "../../friends/friends.model.js"
import { grantPermission, revokePermission } from "../sharing.model.js"

const ws = vi.hoisted(() => ({ sendToUser: vi.fn(), hasOtherClients: vi.fn(() => true) }))
vi.mock("../../../../ws/wsServer.js", async (orig) => ({ ...(await orig<object>()), ...ws }))

type User = Awaited<ReturnType<typeof signup>>
let lifter: User, w1: User, w2: User, idle: User
let w2Grant: number
let sessionId: number

const progressFor = (u: User) =>
  ws.sendToUser.mock.calls.filter(([to, type]) => to === u.user.id && type === "watch_progress")
const lastLive = (u: User) => progressFor(u).at(-1)?.[2] as { liveSession: { setTimings: { weight: number }[] } | null }

beforeAll(async () => {
  ;[lifter, w1, w2, idle] = [await signup("wpl"), await signup("wpa"), await signup("wpb"), await signup("wpc")]
  const l = await internalId(lifter.user.id)
  for (const u of [w1, w2, idle]) {
    const id = await internalId(u.user.id)
    await acceptFriendRequest(id, await sendFriendRequest(l, id))
    const grant = await grantPermission(l, id, "watch_session")
    if (u === w2) w2Grant = grant
  }
  sessionId = (await request(app).post("/api/sessions/start").set(auth(lifter.token)).send({ dayNumber: 1, dayTitle: "Push" }))
    .body.session.id
  for (const u of [w1, w2])
    await request(app)
      .get(`/api/sharing/watch/friend/${lifter.user.id}/session/${sessionId}/live`)
      .set(auth(u.token))
      .expect(200)
})

describe("watch_progress", () => {
  let setId: number

  it("sends each active watcher the /live snapshot when a set is recorded", async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(lifter.token))
      .send({ exerciseName: "Bench", setIndex: 0, startTime: "2026-01-01T10:00:00Z", endTime: "2026-01-01T10:01:00Z", weight: 60, reps: 8 })
      .expect(200)
    setId = res.body.timing.id

    await vi.waitFor(() => expect(progressFor(w1)).toHaveLength(1))
    const live = (await request(app)
      .get(`/api/sharing/watch/friend/${lifter.user.id}/session/${sessionId}/live`)
      .set(auth(w1.token))).body.liveSession
    expect(progressFor(w1)[0]![2]).toEqual({ friendId: lifter.user.id, sessionId, liveSession: live })
    expect(progressFor(w2)).toHaveLength(1)
    expect(progressFor(idle)).toHaveLength(0)
    expect(progressFor(lifter)).toHaveLength(0)
  })

  it("pushes an edited set", async () => {
    await request(app)
      .patch(`/api/sessions/${sessionId}/sets/${setId}`)
      .set(auth(lifter.token))
      .send({ weight: 70 })
      .expect(200)
    await vi.waitFor(() => expect(progressFor(w1)).toHaveLength(1))
    expect(lastLive(w1).liveSession!.setTimings[0]!.weight).toBe(70)
  })

  it("stops pushing to a watcher the moment their grant is revoked", async () => {
    await revokePermission(await internalId(lifter.user.id), w2Grant)
    await request(app)
      .delete(`/api/sessions/${sessionId}/sets?exerciseName=Bench&setIndex=0`)
      .set(auth(lifter.token))
      .expect(200)
    await vi.waitFor(() => expect(progressFor(w1)).toHaveLength(1))
    expect(lastLive(w1).liveSession!.setTimings).toEqual([])
    expect(progressFor(w2)).toHaveLength(0)
  })

  it("sends a null snapshot when the session ends", async () => {
    await request(app).post(`/api/sessions/${sessionId}/end`).set(auth(lifter.token)).send({}).expect(200)
    await vi.waitFor(() => expect(progressFor(w1)).toHaveLength(1))
    expect(lastLive(w1).liveSession).toBeNull()
  })
})
