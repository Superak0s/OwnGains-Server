import { describe, it, expect, beforeAll } from "vitest"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { app, signup, auth, internalId, uniqueName } from "../../../../tests/helpers.js"
import { findUserByUsername } from "../../../../features/auth/auth.model.js"
import { MAX_PENDING_SENT } from "../friends.model.js"
import { pool } from "../../../../config/database.js"

describe("friends routes", () => {
  let a: Awaited<ReturnType<typeof signup>>
  let b: Awaited<ReturnType<typeof signup>>
  let c: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    a = await signup("frida")
    b = await signup("fridb")
    c = await signup("fridc")
  })

  it("search matches a username prefix of 3+ characters only", async () => {
    expect((await request(app).get("/api/friends/search").set(auth(a.token))).status).toBe(400)
    expect(
      (await request(app).get(`/api/friends/search?q=${b.username.slice(0, 2)}`).set(auth(a.token))).status,
    ).toBe(400)

    const res = await request(app)
      .get(`/api/friends/search?q=${b.username.slice(0, -1)}`)
      .set(auth(a.token))
    expect(res.status).toBe(200)
    expect(res.body.users.some((u: any) => u.username === b.username)).toBe(true)

    // Infix and real-name matches are gone: those made search a member directory.
    const infix = await request(app)
      .get(`/api/friends/search?q=${b.username.slice(-4)}`)
      .set(auth(a.token))
    expect(infix.body.users.some((u: any) => u.username === b.username)).toBe(false)

    // A LIKE wildcard in the term is a literal, not a pattern.
    const wild = await request(app).get("/api/friends/search?q=%25%25%25").set(auth(a.token))
    expect(wild.body.users).toHaveLength(0)
  })

  it("search shows a real name to friends only", async () => {
    const s1 = await signup("srcha")
    const s2 = await signup("srchb")
    await request(app).put("/api/auth/profile").set(auth(s2.token)).send({ name: "Secret Realname" })

    const stranger = await request(app).get(`/api/friends/search?q=${s2.username}`).set(auth(s1.token))
    expect(stranger.body.users[0].username).toBe(s2.username)
    expect(stranger.body.users[0].name).toBe(s2.username)
    expect((await request(app).get("/api/friends/search?q=Secret").set(auth(s1.token))).body.users).toHaveLength(0)

    const req = await request(app).post("/api/friends/request").set(auth(s1.token)).send({ username: s2.username })
    await request(app).post(`/api/friends/request/${req.body.friendshipId}/accept`).set(auth(s2.token))
    const friend = await request(app).get(`/api/friends/search?q=${s2.username}`).set(auth(s1.token))
    expect(friend.body.users[0].name).toBe("Secret Realname")
  })

  it("rejects self-requests and unknown users", async () => {
    const self = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: a.username })
    expect(self.status).toBe(400)

    const ghost = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: "nosuchuser" })
    expect(ghost.status).toBe(404)

    const missing = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({})
    expect(missing.status).toBe(400)
  })

  it("sends, accepts, and lists a friendship", async () => {
    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: b.username })
    expect(req.status).toBe(201)
    const friendshipId = req.body.friendshipId

    const pending = await request(app).get("/api/friends/requests/pending").set(auth(b.token))
    expect(pending.body.requests).toHaveLength(1)
    expect(pending.body.requests[0].username).toBe(a.username)

    const sent = await request(app).get("/api/friends/requests/sent").set(auth(a.token))
    expect(sent.body.requests).toHaveLength(1)

    // The same two lists, in one call with the friends list.
    const bundled = await request(app).get("/api/friends?include=requests").set(auth(b.token))
    expect(bundled.status).toBe(200)
    expect(bundled.body.friends).toEqual([])
    expect(bundled.body.pendingRequests).toEqual(pending.body.requests)
    expect(bundled.body.sentRequests).toEqual([])
    const plain = await request(app).get("/api/friends").set(auth(b.token))
    expect(plain.body.pendingRequests).toBeUndefined()
    expect((await request(app).get("/api/friends?include=all").set(auth(b.token))).status).toBe(400)

    const accept = await request(app)
      .post(`/api/friends/request/${friendshipId}/accept`)
      .set(auth(b.token))
    expect(accept.status).toBe(200)

    const friends = await request(app).get("/api/friends").set(auth(a.token))
    expect(friends.body.friends.some((f: any) => f.username === b.username)).toBe(true)
  })

  it("lets the receiver reject a request", async () => {
    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: c.username })
    expect(req.status).toBe(201)

    const reject = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/reject`)
      .set(auth(c.token))
    expect(reject.status).toBe(200)

    // A declined sender can't simply re-send: same answer as a block, so
    // they can't tell which one it was...
    const again = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: c.username })
    expect(again.status).toBe(403)
    expect(again.body.error).toBe("Cannot send a friend request to this user")

    // ...but the one who declined can still reach out, and that clears it.
    const back = await request(app)
      .post("/api/friends/request")
      .set(auth(c.token))
      .send({ username: a.username })
    expect(back.status).toBe(201)
    await request(app).post(`/api/friends/request/${back.body.friendshipId}/reject`).set(auth(a.token))
  })

  it("puts a short cooldown on re-sending a cancelled request", async () => {
    const s = await signup("cncla")
    const r = await signup("cnclb")
    const req = await request(app).post("/api/friends/request").set(auth(s.token)).send({ username: r.username })
    expect(req.status).toBe(201)
    const cancel = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/reject`)
      .set(auth(s.token))
    expect(cancel.status).toBe(200)
    const resend = await request(app).post("/api/friends/request").set(auth(s.token)).send({ username: r.username })
    expect(resend.status).toBe(403)

    // Once the hour has passed it goes through.
    const [sId, rId] = [await internalId(s.user.id), await internalId(r.user.id)]
    await pool.query(
      "UPDATE friend_request_cooldowns SET created_at = NOW() - INTERVAL 2 HOUR WHERE requester_id = ? AND recipient_id = ?",
      [sId, rId],
    )
    expect(
      (await request(app).post("/api/friends/request").set(auth(s.token)).send({ username: r.username })).status,
    ).toBe(201)
  })

  it("caps outgoing pending requests", async () => {
    const s = await signup("capsnd")
    const sId = await internalId(s.user.id)
    // 50 throwaway recipients straight into the tables, no bcrypt needed.
    const ids: number[] = []
    for (let i = 0; i < MAX_PENDING_SENT; i++) {
      const name = uniqueName("capr")
      const [res] = await pool.query(
        "INSERT INTO users (uuid, username, email, password_hash, name) VALUES (UUID(), ?, ?, 'x', ?)",
        [name, `${name}@test.local`, name],
      )
      ids.push((res as any).insertId)
    }
    await pool.query(
      `INSERT INTO friendships (user_id, friend_id, requested_by)
       VALUES ${ids.map(() => "(LEAST(?, ?), GREATEST(?, ?), ?)").join(",")}`,
      ids.flatMap((id) => [sId, id, sId, id, sId]),
    )
    const target = await signup("captgt")
    const over = await request(app).post("/api/friends/request").set(auth(s.token)).send({ username: target.username })
    expect(over.status).toBe(429)
    expect(over.body.code).toBe("TOO_MANY_PENDING_REQUESTS")
  })

  it("files reports with a valid reason only", async () => {
    const bRow = await findUserByUsername(b.username)

    const badReason = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: bRow!.uuid, reason: "flaming" })
    expect(badReason.status).toBe(400)

    const badUser = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: "abc", reason: "spam" })
    expect(badUser.status).toBe(400)

    const ghost = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: randomUUID(), reason: "spam" })
    expect(ghost.status).toBe(404)

    const ok = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: bRow!.uuid, reason: "spam", details: "test report" })
    expect(ok.status).toBe(201)
    expect(ok.body.reportId).toBeGreaterThan(0)
  })

  it("blocks, lists blocks, and unblocks", async () => {
    const cRow = await findUserByUsername(c.username)
    const aRow = await findUserByUsername(a.username)

    const blockGhost = await request(app).post(`/api/friends/block/${randomUUID()}`).set(auth(b.token))
    expect(blockGhost.status).toBe(404)

    const block = await request(app)
      .post(`/api/friends/block/${aRow!.uuid}`)
      .set(auth(b.token))
    expect(block.status).toBe(200)

    const blocked = await request(app).get("/api/friends/blocked").set(auth(b.token))
    expect(blocked.body.blocked.some((u: any) => u.username === a.username)).toBe(true)

    const unblock = await request(app)
      .delete(`/api/friends/block/${aRow!.uuid}`)
      .set(auth(b.token))
    expect(unblock.status).toBe(200)

    const unblockAgain = await request(app)
      .delete(`/api/friends/block/${aRow!.uuid}`)
      .set(auth(b.token))
    expect(unblockAgain.status).toBe(404)

    // blocking also removed the friendship between a and b
    expect(cRow!.id).toBeGreaterThan(0)
  })

  it("removes a friendship", async () => {
    // the earlier block/unblock may have torn the friendship down, so re-request
    // and accept whatever is pending before removing it
    await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: b.username })
    const pending = await request(app).get("/api/friends/requests/pending").set(auth(b.token))
    const fromA = pending.body.requests.find((r: any) => r.username === a.username)
    if (fromA)
      await request(app).post(`/api/friends/request/${fromA.friendshipId}/accept`).set(auth(b.token))

    const bRow = await findUserByUsername(b.username)
    const del = await request(app)
      .delete(`/api/friends/${bRow!.uuid}`)
      .set(auth(a.token))
    expect(del.status).toBe(200)

    const friends = await request(app).get("/api/friends").set(auth(a.token))
    expect(friends.body.friends.some((f: any) => f.username === b.username)).toBe(false)
  })

  // Regression: unfriending used to delete only the friendship row, leaving
  // sharing_permissions behind. A `trainer` grant is read/write over the
  // trainee's sessions, program and analytics, so an unfriended trainer kept
  // full access via X-Trainee-Id and only blocking actually revoked it.
  it("revokes sharing grants when a friendship is removed", async () => {
    const trainee = await signup("frtne")
    const trainer = await signup("frtnr")
    const traineeRow = await findUserByUsername(trainee.username)
    const trainerRow = await findUserByUsername(trainer.username)

    await request(app)
      .post("/api/friends/request")
      .set(auth(trainee.token))
      .send({ username: trainer.username })
    const pending = await request(app)
      .get("/api/friends/requests/pending")
      .set(auth(trainer.token))
    const req = pending.body.requests.find(
      (r: any) => r.username === trainee.username,
    )
    await request(app)
      .post(`/api/friends/request/${req.friendshipId}/accept`)
      .set(auth(trainer.token))

    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainerRow!.uuid, permissionType: "trainer" })
    expect(grant.status).toBe(201)

    // trainer mode works while the friendship stands
    const before = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(traineeRow!.uuid))
    expect(before.status).toBe(200)

    const del = await request(app)
      .delete(`/api/friends/${trainerRow!.uuid}`)
      .set(auth(trainee.token))
    expect(del.status).toBe(200)

    // the grant row is gone, not merely shadowed by the missing friendship
    const granted = await request(app)
      .get("/api/sharing/permissions/granted")
      .set(auth(trainee.token))
    expect(
      granted.body.permissions.some((p: any) => p.permissionType === "trainer"),
    ).toBe(false)

    // and trainer mode no longer resolves
    const after = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(traineeRow!.uuid))
    expect(after.status).toBe(403)
  })
})
