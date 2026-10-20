import { describe, it, expect } from "vitest"
import request from "supertest"
import nacl from "tweetnacl"
import { app, signup, auth } from "../../../tests/helpers.js"

const KEY_A = "A".repeat(43) + "="
const KEY_B = "B".repeat(43) + "="
const NONCE = "N".repeat(32)
const SENDER = "S".repeat(43) + "="

async function coachWithClient(includeTracking: boolean) {
  const coach = await signup("tcoach")
  const client = await signup("tclient")
  const sent = await request(app)
    .post("/api/trainer/requests")
    .set(auth(coach.token))
    .send({ toUserId: client.user.id, includeTracking })
  await request(app)
    .post(`/api/trainer/requests/${sent.body.data.request.id}/accept`)
    .set(auth(client.token))
    .send({ includeTracking })
  return { coach, client }
}

const registerKey = (token: string, deviceId: string, publicKey: string) =>
  request(app).put("/api/sharing/tracking/devices/key").set(auth(token)).send({ deviceId, publicKey })

const sendMessage = (token: string, body: Record<string, unknown>) =>
  request(app)
    .post("/api/sharing/tracking/messages")
    .set(auth(token))
    .send({ nonce: NONCE, senderKey: SENDER, ciphertext: "Y2lwaGVy", ...body })

const pending = async (token: string, deviceId: string) =>
  (await request(app).get(`/api/sharing/tracking/messages?deviceId=${deviceId}`).set(auth(token))).body.data
    .messages

describe("tracking relay", () => {
  it("relays ciphertext from a client to each trainer device until it is acknowledged", async () => {
    const { coach, client } = await coachWithClient(true)

    const clients = await request(app).get("/api/trainer/clients?weekStart=2026-10-12").set(auth(coach.token))
    expect(clients.body.data.clients[0]).toMatchObject({ userId: client.user.id, hasTrackingAccess: true })

    expect((await registerKey(coach.token, "short", KEY_A)).status).toBe(400)
    expect((await registerKey(coach.token, "phone-0001", "nope")).status).toBe(400)
    const keyId = (await registerKey(coach.token, "phone-0001", KEY_A)).body.data.keyId
    expect((await registerKey(coach.token, "phone-0001", KEY_A)).body.data.keyId).toBe(keyId)

    const recipients = await request(app).get("/api/sharing/tracking/recipients").set(auth(client.token))
    expect(recipients.body.data.recipients).toEqual([
      { trainerId: coach.user.id, keys: [{ keyId, publicKey: KEY_A, resend: false }] },
    ])

    // Only the client who granted Tracking Access can send to that trainer's keys.
    expect((await sendMessage(coach.token, { keyId, kind: "snapshot" })).status).toBe(404)
    expect((await sendMessage(client.token, { keyId, kind: "photo" })).status).toBe(400)
    expect((await sendMessage(client.token, { keyId, kind: "photo", ref: "p1" })).status).toBe(201)
    expect((await sendMessage(client.token, { keyId, kind: "snapshot", ciphertext: "b2xk" })).status).toBe(201)
    expect((await sendMessage(client.token, { keyId, kind: "snapshot", ciphertext: "bmV3" })).status).toBe(201)

    const messages = await pending(coach.token, "phone-0001")
    expect(messages.map((m: { kind: string; ref: string; ciphertext: string; clientId: string }) => [m.kind, m.ref, m.ciphertext, m.clientId])).toEqual([
      ["photo", "p1", "Y2lwaGVy", client.user.id],
      ["snapshot", "", "bmV3", client.user.id],
    ])
    // Another user's ack of the same ids deletes nothing.
    await request(app).post("/api/sharing/tracking/messages/ack").set(auth(client.token)).send({ deviceId: "phone-0001", ids: messages.map((m: { id: string }) => m.id) })
    expect(await pending(coach.token, "phone-0001")).toHaveLength(2)
    await request(app).post("/api/sharing/tracking/messages/ack").set(auth(coach.token)).send({ deviceId: "phone-0001", ids: messages.map((m: { id: string }) => m.id) })
    expect(await pending(coach.token, "phone-0001")).toEqual([])

    // A resend request shows on the client's recipients until the next snapshot.
    const resend = await request(app)
      .post("/api/sharing/tracking/resend-requests")
      .set(auth(coach.token))
      .send({ deviceId: "phone-0001", clientId: client.user.id })
    expect(resend.status).toBe(200)
    const flagged = await request(app).get("/api/sharing/tracking/recipients").set(auth(client.token))
    expect(flagged.body.data.recipients[0].keys[0].resend).toBe(true)
    await sendMessage(client.token, { keyId, kind: "snapshot" })
    const cleared = await request(app).get("/api/sharing/tracking/recipients").set(auth(client.token))
    expect(cleared.body.data.recipients[0].keys[0].resend).toBe(false)

    // A new key for the device is a new id, and what was sent to the old one is gone.
    const rotated = (await registerKey(coach.token, "phone-0001", KEY_B)).body.data.keyId
    expect(rotated).not.toBe(keyId)
    expect(await pending(coach.token, "phone-0001")).toEqual([])
  })

  it("ends Tracking Access and its pending messages with Trainer Access", async () => {
    const { coach, client } = await coachWithClient(true)
    const keyId = (await registerKey(coach.token, "phone-0002", KEY_A)).body.data.keyId
    await sendMessage(client.token, { keyId, kind: "snapshot" })

    const granted = await request(app).get("/api/sharing/permissions/granted").set(auth(client.token))
    const trainer = granted.body.permissions.find((p: { permissionType: string }) => p.permissionType === "trainer")
    await request(app).delete(`/api/sharing/permissions/${trainer.id}`).set(auth(client.token))

    const after = await request(app).get("/api/sharing/permissions/granted").set(auth(client.token))
    expect(after.body.permissions).toEqual([])
    expect(await pending(coach.token, "phone-0002")).toEqual([])
    expect((await sendMessage(client.token, { keyId, kind: "snapshot" })).status).toBe(404)
  })

  it("only grants Tracking Access on top of Trainer Access", async () => {
    const { coach, client } = await coachWithClient(false)
    const clients = await request(app).get("/api/trainer/clients?weekStart=2026-10-12").set(auth(coach.token))
    expect(clients.body.data.clients[0].hasTrackingAccess).toBe(false)
    expect((await request(app).get("/api/sharing/tracking/recipients").set(auth(client.token))).body.data.recipients).toEqual([])

    const stranger = await signup("tstranger")
    const grant = (token: string, friendId: string) =>
      request(app).post("/api/sharing/permissions").set(auth(token)).send({ friendId, permissionType: "tracking" })
    expect((await grant(client.token, coach.user.id)).status).toBe(201)
    expect((await grant(coach.token, client.user.id)).status).toBe(409)
    expect((await grant(client.token, stranger.user.id)).status).toBe(403)
  })

  it("seals a demo snapshot from each demo client with Tracking Access to the owner's device", async () => {
    const owner = await signup("tdmo")
    const keys = nacl.box.keyPair()
    await registerKey(owner.token, "phone-demo1", Buffer.from(keys.publicKey).toString("base64")).expect(200)
    await request(app)
      .post("/api/sessions/demo")
      .set(auth(owner.token))
      .send({ days: [{ dayNumber: 1, dayTitle: "Push", exercises: [{ name: "Bench Press", sets: 2 }] }] })
      .expect(200)

    const messages = await pending(owner.token, "phone-demo1")
    expect(messages).toHaveLength(1)
    const b = (s: string) => new Uint8Array(Buffer.from(s, "base64"))
    for (const m of messages) {
      const plain = nacl.box.open(b(m.ciphertext), b(m.nonce), b(m.senderKey), keys.secretKey)
      expect(JSON.parse(Buffer.from(plain!).toString()).records.body_weight).toHaveLength(8)
    }
  })
})
