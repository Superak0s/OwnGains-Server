import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId, befriend } from "../../../tests/helpers.js"
import { pool } from "@/config/database.js"

const send = (token: string, to: string, body: unknown) =>
  request(app).post(`/api/messages/${to}`).set(auth(token)).send({ body })
const thread = (token: string, other: string, query = "") =>
  request(app).get(`/api/messages/${other}${query}`).set(auth(token))
const inbox = async (token: string) =>
  (await request(app).get("/api/messages").set(auth(token))).body.conversations

describe("messages routes", () => {
  it("lets friends talk, pages, counts unread and marks read", async () => {
    const ann = await signup("msga")
    const ben = await signup("msgb")
    const stranger = await signup("msgs")

    expect((await send(ann.token, ben.user.id, "hi")).status).toBe(403)
    expect((await send(ann.token, ben.user.id, "hi")).body.code).toBe("NOT_ALLOWED")
    await befriend(ann, ben)

    expect((await send(ann.token, ben.user.id, "   ")).status).toBe(400)
    expect((await send(ann.token, ben.user.id, 42)).status).toBe(400)
    expect((await send(ann.token, ben.user.id, "x".repeat(2001))).status).toBe(400)
    expect((await send(ann.token, ann.user.id, "me")).status).toBe(404)
    expect((await send(ann.token, "00000000-0000-4000-8000-000000000000", "hi")).status).toBe(404)
    expect((await send(ann.token, "not-a-uuid", "hi")).status).toBe(400)
    expect((await send(stranger.token, ann.user.id, "hi")).status).toBe(403)

    const first = await send(ann.token, ben.user.id, "  hello  ")
    expect(first.status).toBe(201)
    expect(first.body.message).toMatchObject({ fromMe: true, body: "hello", readAt: null })
    await send(ben.token, ann.user.id, "hey")
    await send(ann.token, ben.user.id, "how are you")

    const page = await thread(ben.token, ann.user.id, "?limit=2")
    expect(page.status).toBe(200)
    expect(page.body.canSend).toBe(true)
    expect(page.body.messages.map((m: { body: string }) => m.body)).toEqual(["how are you", "hey"])
    expect(page.body.messages[0].fromMe).toBe(false)
    const older = await thread(ben.token, ann.user.id, `?before=${page.body.messages[1].id}`)
    expect(older.body.messages.map((m: { body: string }) => m.body)).toEqual(["hello"])

    const [benThread] = await inbox(ben.token)
    expect(benThread).toMatchObject({
      userUuid: ann.user.id,
      username: ann.username,
      unreadCount: 2,
      relation: null,
      lastMessage: { body: "how are you", fromMe: false },
    })

    expect((await request(app).post(`/api/messages/${ann.user.id}/read`).set(auth(ben.token))).status).toBe(200)
    expect((await inbox(ben.token))[0].unreadCount).toBe(0)
    const seen = await thread(ann.token, ben.user.id)
    expect(seen.body.messages.filter((m: { fromMe: boolean }) => m.fromMe).every((m: { readAt: string | null }) => m.readAt)).toBe(true)
    expect(await inbox(stranger.token)).toEqual([])
  })

  it("replays an idempotent send instead of storing it twice", async () => {
    const a = await signup("msgi")
    const b = await signup("msgj")
    await befriend(a, b)
    const post = () =>
      request(app).post(`/api/messages/${b.user.id}`).set(auth(a.token)).set("Idempotency-Key", "k1").send({ body: "once" })
    const one = await post()
    const two = await post()
    expect(two.body.message.id).toBe(one.body.message.id)
    expect((await thread(a.token, b.user.id)).body.messages).toHaveLength(1)
  })

  it("allows a trainer and client without a friendship, until the grant is revoked", async () => {
    const coach = await signup("msgc")
    const client = await signup("msgk")
    const sent = await request(app)
      .post("/api/trainer/requests")
      .set(auth(coach.token))
      .send({ toUserId: client.user.id, includeTracking: false })
    await request(app)
      .post(`/api/trainer/requests/${sent.body.data.request.id}/accept`)
      .set(auth(client.token))
      .send({ includeTracking: false })
    // Accepting also befriends them. Drop that so only the grant allows it.
    const [coachId, clientId] = [await internalId(coach.user.id), await internalId(client.user.id)]
    await pool.execute("DELETE FROM friendships WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)", [
      coachId, clientId, coachId, clientId,
    ])

    expect((await send(coach.token, client.user.id, "leg day")).status).toBe(201)
    expect((await send(client.token, coach.user.id, "ok")).status).toBe(201)
    expect((await inbox(client.token))[0].relation).toBe("trainer")
    expect((await inbox(coach.token))[0].relation).toBe("client")

    await pool.execute("DELETE FROM sharing_permissions WHERE from_user_id = ? AND permission_type = 'trainer'", [clientId])
    expect((await send(coach.token, client.user.id, "still there?")).status).toBe(403)
    const history = await thread(client.token, coach.user.id)
    expect(history.body.canSend).toBe(false)
    expect(history.body.messages).toHaveLength(2)
  })

  it("keeps received messages when the recipient clears their data, and drops them with the sender's account", async () => {
    const a = await signup("msgw")
    const b = await signup("msgx")
    await befriend(a, b)
    await send(a.token, b.user.id, "from a")
    await send(b.token, a.user.id, "from b")

    await request(app).delete("/api/auth/account/data").set(auth(b.token)).send({ password: b.password, confirmDelete: "DELETE_ALL_DATA" })
    expect((await thread(a.token, b.user.id)).body.messages.map((m: { body: string }) => m.body)).toEqual(["from a"])

    const aId = await internalId(a.user.id)
    await request(app).delete("/api/auth/account").set(auth(a.token)).send({ password: a.password })
    const [rows] = await pool.execute("SELECT id FROM messages WHERE sender_id = ? OR recipient_id = ?", [aId, aId])
    expect(rows).toEqual([])
  })

  it("lets the owner open and answer their demo friends, and nobody else", async () => {
    const owner = await signup("msgdmo")
    const other = await signup("msgdmo2")
    const days = [{ dayNumber: 1, dayTitle: "Push", exercises: [{ name: "Bench Press", sets: 1 }] }]
    await request(app).post("/api/sessions/demo").set(auth(owner.token)).send({ split: "Demo", days })
    const demoUuid = (await inbox(owner.token))[0].userUuid

    const opened = await thread(owner.token, demoUuid)
    expect(opened.status).toBe(200)
    expect(opened.body.messages.length).toBeGreaterThan(0)
    expect((await send(owner.token, demoUuid, "hey")).status).toBe(201)
    expect((await thread(other.token, demoUuid)).status).toBe(404)
  })

  it("lets the sender edit within 15 minutes and delete at any time", async () => {
    const ann = await signup("msgea")
    const ben = await signup("msgeb")
    await befriend(ann, ben)
    const id = (await send(ann.token, ben.user.id, "helo")).body.message.id
    const edit = (token: string, to: string, msgId: unknown, body: unknown) =>
      request(app).patch(`/api/messages/${to}/${msgId}`).set(auth(token)).send({ body })
    const del = (token: string, to: string, msgId: unknown) =>
      request(app).delete(`/api/messages/${to}/${msgId}`).set(auth(token))

    expect((await edit(ann.token, ben.user.id, "abc", "hello")).status).toBe(400)
    expect((await edit(ann.token, ben.user.id, id, "  ")).status).toBe(400)
    expect((await edit(ben.token, ann.user.id, id, "hacked")).status).toBe(404)
    const ok = await edit(ann.token, ben.user.id, id, " hello ")
    expect(ok.status).toBe(200)
    expect(ok.body.message).toMatchObject({ id, fromMe: true, body: "hello" })
    expect(ok.body.message.editedAt).toEqual(expect.any(String))
    expect((await thread(ben.token, ann.user.id)).body.messages[0]).toMatchObject({ body: "hello", editedAt: ok.body.message.editedAt })
    expect((await inbox(ben.token))[0].lastMessage.body).toBe("hello")

    await pool.execute("UPDATE messages SET created_at = NOW() - INTERVAL 16 MINUTE WHERE id = ?", [id])
    const late = await edit(ann.token, ben.user.id, id, "too late")
    expect(late.status).toBe(403)
    expect(late.body.code).toBe("EDIT_WINDOW_CLOSED")

    expect((await del(ann.token, ben.user.id, "abc")).status).toBe(400)
    expect((await del(ben.token, ann.user.id, id)).status).toBe(404)
    expect((await del(ann.token, ben.user.id, id)).body).toEqual({ success: true })
    expect((await del(ann.token, ben.user.id, id)).status).toBe(404)
    expect((await thread(ben.token, ann.user.id)).body.messages).toEqual([])
  })

  it("refuses sends and edits after a block, but still lets the sender delete", async () => {
    const ann = await signup("msgba")
    const ben = await signup("msgbb")
    await befriend(ann, ben)
    const id = (await send(ann.token, ben.user.id, "before")).body.message.id
    await request(app).post(`/api/friends/block/${ann.user.id}`).set(auth(ben.token))

    const sent = await send(ann.token, ben.user.id, "after")
    expect(sent.status).toBe(403)
    expect(sent.body.code).toBe("NOT_ALLOWED")
    const edited = await request(app).patch(`/api/messages/${ben.user.id}/${id}`).set(auth(ann.token)).send({ body: "rewritten" })
    expect(edited.status).toBe(403)
    expect(edited.body.code).toBe("NOT_ALLOWED")
    expect((await thread(ben.token, ann.user.id)).body.messages[0]).toMatchObject({ body: "before", editedAt: null })
    expect((await request(app).delete(`/api/messages/${ben.user.id}/${id}`).set(auth(ann.token))).status).toBe(200)
  })
})
