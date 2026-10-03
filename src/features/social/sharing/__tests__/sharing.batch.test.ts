import { describe, it, expect, beforeAll } from "vitest"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

type User = Awaited<ReturnType<typeof signup>>

async function befriend(a: User, b: User) {
  const req = await request(app)
    .post("/api/friends/request")
    .set(auth(a.token))
    .send({ username: b.username })
  expect(req.status).toBe(201)
  await request(app)
    .post(`/api/friends/request/${req.body.friendshipId}/accept`)
    .set(auth(b.token))
    .expect(200)
}

async function startSession(u: User, startTime?: string): Promise<number> {
  const res = await request(app)
    .post("/api/sessions/start")
    .set(auth(u.token))
    .send({ dayNumber: 1, dayTitle: "Push", ...(startTime && { startTime }) })
  expect(res.status).toBe(200)
  return res.body.session.id
}

async function logSet(u: User, sessionId: number, exerciseName: string, setIndex: number) {
  await request(app)
    .post(`/api/sessions/${sessionId}/set`)
    .set(auth(u.token))
    .send({
      exerciseName,
      setIndex,
      startTime: "2024-01-15T10:00:00Z",
      endTime: "2024-01-15T10:01:00Z",
      weight: 80,
      reps: 5,
    })
    .expect(200)
}

describe("GET /api/sharing/sessions/friend/:friendId?includeTimings=true", () => {
  let viewer: User
  let owner: User
  let withSets: number
  let empty: number

  beforeAll(async () => {
    viewer = await signup("incv")
    owner = await signup("inco")
    await befriend(viewer, owner)
    await request(app)
      .post("/api/sharing/permissions")
      .set(auth(owner.token))
      .send({ friendId: viewer.user.id, permissionType: "history" })
      .expect(201)

    withSets = await startSession(owner, "2024-01-15T09:00:00Z")
    await logSet(owner, withSets, "Squat", 0)
    await logSet(owner, withSets, "Bench Press", 0)
    await request(app).post(`/api/sessions/${withSets}/end`).set(auth(owner.token)).expect(200)
    empty = await startSession(owner, "2024-01-16T09:00:00Z")
    await request(app).post(`/api/sessions/${empty}/end`).set(auth(owner.token)).expect(200)
  })

  it("is unchanged without the param", async () => {
    const res = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}`)
      .set(auth(viewer.token))
    expect(res.status).toBe(200)
    expect(res.body.sessions).toHaveLength(2)
    for (const s of res.body.sessions) expect(s).not.toHaveProperty("setTimings")
  })

  it("carries each session's detail-route setTimings, [] included", async () => {
    const res = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}?includeTimings=true`)
      .set(auth(viewer.token))
    expect(res.status).toBe(200)
    const byId = Object.fromEntries(
      res.body.sessions.map((s: { id: number }) => [s.id, s]),
    )
    expect(byId[empty].setTimings).toEqual([])

    const detail = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}/${withSets}`)
      .set(auth(viewer.token))
    expect(detail.status).toBe(200)
    expect(byId[withSets].setTimings).toEqual(detail.body.session.setTimings)
    // Performed order, as the owner's own history lists them, not by name.
    expect(
      byId[withSets].setTimings.map((t: { exerciseName: string }) => t.exerciseName),
    ).toEqual(["Squat", "Bench Press"])
  })

  it("pages with nextCursor like the owner's history", async () => {
    const first = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}?limit=1`)
      .set(auth(viewer.token))
    expect(first.body.sessions.map((s: { id: number }) => s.id)).toEqual([empty])
    expect(first.body.nextCursor).toEqual(expect.any(String))

    const second = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}?limit=1&before=${encodeURIComponent(first.body.nextCursor)}`)
      .set(auth(viewer.token))
    expect(second.body.sessions.map((s: { id: number }) => s.id)).toEqual([withSets])

    const all = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}`)
      .set(auth(viewer.token))
    expect(all.body.nextCursor).toBeNull()

    const bad = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}?before=nope`)
      .set(auth(viewer.token))
    expect(bad.status).toBe(400)
  })

  it("still needs the history grant", async () => {
    const stranger = await signup("incs")
    await befriend(stranger, owner)
    const res = await request(app)
      .get(`/api/sharing/sessions/friend/${owner.user.id}?includeTimings=true`)
      .set(auth(stranger.token))
    expect(res.status).toBe(403)
  })
})

describe("GET /api/sharing/joint-sessions/status", () => {
  let me: User
  let active: User
  let idle: User
  let notFriend: User
  let activeSessionId: number

  beforeAll(async () => {
    me = await signup("stme")
    active = await signup("stact")
    idle = await signup("stidl")
    notFriend = await signup("stnf")
    await befriend(me, active)
    await befriend(idle, me)
    await request(app)
      .post("/api/sharing/permissions")
      .set(auth(active.token))
      .send({ friendId: me.user.id, permissionType: "joint_session" })
      .expect(201)
    activeSessionId = await startSession(active)
    await startSession(notFriend)
  })

  it("returns every friend's status in one call and omits non-friends", async () => {
    const ids = [active.user.id, idle.user.id, notFriend.user.id, randomUUID(), "not-a-uuid"]
    const res = await request(app)
      .get(`/api/sharing/joint-sessions/status?friendIds=${ids.join(",")}`)
      .set(auth(me.token))
    expect(res.status).toBe(200)
    expect(Object.keys(res.body.statuses).sort()).toEqual(
      [active.user.id, idle.user.id].sort(),
    )
    expect(res.body.statuses[idle.user.id]).toEqual({
      hasActiveSession: false,
      sessionId: null,
      startedAt: null,
    })

    // Same object the single-friend route returns.
    const single = await request(app)
      .get(`/api/sharing/joint-sessions/friend/${active.user.id}/status`)
      .set(auth(me.token))
    const { success: _, ...singleStatus } = single.body
    expect(res.body.statuses[active.user.id]).toEqual(singleStatus)
    expect(singleStatus).toMatchObject({ hasActiveSession: true, sessionId: activeSessionId })
    expect(new Date(singleStatus.startedAt).toISOString()).toBe(singleStatus.startedAt)
  })

  it("hides an active workout from friends without a live grant", async () => {
    await startSession(idle)
    const hidden = await request(app)
      .get(`/api/sharing/joint-sessions/status?friendIds=${idle.user.id}`)
      .set(auth(me.token))
    expect(hidden.body.statuses[idle.user.id].hasActiveSession).toBe(false)
  })

  it("rejects a missing or oversized friendIds list", async () => {
    const missing = await request(app)
      .get("/api/sharing/joint-sessions/status")
      .set(auth(me.token))
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ success: false, error: "friendIds is required" })

    const tooMany = Array.from({ length: 101 }, () => randomUUID()).join(",")
    const over = await request(app)
      .get(`/api/sharing/joint-sessions/status?friendIds=${tooMany}`)
      .set(auth(me.token))
    expect(over.status).toBe(400)
    expect(over.body).toMatchObject({ success: false, error: "Too many friend ids" })

    expect((await request(app).get("/api/sharing/joint-sessions/status?friendIds=x")).status).toBe(401)
  })
})
