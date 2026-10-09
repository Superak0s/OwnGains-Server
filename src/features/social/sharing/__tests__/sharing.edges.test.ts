// Watch and joint-session rejections sharing.routes.test.ts doesn't reach,
// plus the watch refresh and expiry.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

afterEach(() => vi.restoreAllMocks())

describe("sharing route edges", () => {
  let a: Awaited<ReturnType<typeof signup>>
  let b: Awaited<ReturnType<typeof signup>>
  let c: Awaited<ReturnType<typeof signup>>
  const as = (u: typeof a) => ({
    get: (path: string) => request(app).get(`/api/sharing${path}`).set(auth(u.token)),
    post: (path: string, body: object = {}) => request(app).post(`/api/sharing${path}`).set(auth(u.token)).send(body),
  })

  beforeAll(async () => {
    ;[a, b, c] = [await signup("shea"), await signup("sheb"), await signup("shec")]
    const req = await request(app).post("/api/friends/request").set(auth(a.token)).send({ username: b.username })
    await request(app).post(`/api/friends/request/${req.body.friendshipId}/accept`).set(auth(b.token))
  })

  it("refuses non-friends and missing grants, and 404s a friend with no workout", async () => {
    expect((await as(c).get(`/joint-sessions/friend/${a.user.id}/status`)).status).toBe(403)
    expect((await as(c).get(`/watch/friend/${a.user.id}/active`)).status).toBe(403)
    expect((await as(c).get(`/watch/friend/${a.user.id}/session/1/live`)).status).toBe(403)
    expect((await as(b).get(`/watch/friend/${a.user.id}/session/1/live`)).status).toBe(403)
    expect((await as(a).post("/permissions", { friendId: b.user.id, permissionType: "watch_session" })).status).toBe(201)
    expect((await as(b).get(`/watch/friend/${a.user.id}/active`)).status).toBe(404)
  })

  it("needs a target and an active workout on both sides of an invite", async () => {
    expect((await as(a).post("/joint-sessions/invite")).status).toBe(400)
    expect((await as(b).post("/permissions", { friendId: a.user.id, permissionType: "joint_session" })).status).toBe(201)
    expect((await as(a).post("/joint-sessions/invite", { toUserId: b.user.id })).status).toBe(400)

    await request(app).post("/api/sessions/start").set(auth(a.token)).send({ dayNumber: 1, dayTitle: "A" })
    const invite = await as(a).post("/joint-sessions/invite", { toUserId: b.user.id })
    expect(invite.status).toBe(201)
    expect((await as(b).post(`/joint-sessions/invites/${invite.body.inviteId}/accept`)).status).toBe(400)

    await request(app).post("/api/sessions/start").set(auth(b.token)).send({ dayNumber: 1, dayTitle: "B" })
    const accept = await as(b).post(`/joint-sessions/invites/${invite.body.inviteId}/accept`)
    expect(accept.status).toBe(200)
    const progress = await request(app)
      .patch(`/api/sharing/joint-sessions/${accept.body.jointSession.id}/progress`)
      .set(auth(b.token))
      .send({ setIndex: 1 })
    expect(progress.status).toBe(200)
  })

  it("refreshes a watch on every poll and drops it after 150s of silence", async () => {
    const live = await as(b).get(`/watch/friend/${a.user.id}/active`)
    const path = `/watch/friend/${a.user.id}/session/${live.body.session.sessionId}/live`
    const timers = vi.spyOn(globalThis, "setTimeout")
    expect((await as(b).get(path)).status).toBe(200)
    expect((await as(b).get(path)).status).toBe(200)
    const expiries = timers.mock.calls.filter(([, ms]) => ms === 150_000)
    expect(expiries).toHaveLength(2)
    ;(expiries[1]![0] as () => void)()
  })
})
