// Data-isolation regression: the account export must name every other user
// by uuid, including columns with no foreign key to declare them.
import { describe, it, expect } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"

async function befriend(a: { token: string }, b: { token: string; username: string }) {
  const req = await request(app)
    .post("/api/friends/request")
    .set(auth(a.token))
    .send({ username: b.username })
  expect(req.status).toBe(201)
  const accept = await request(app)
    .post(`/api/friends/request/${req.body.friendshipId}/accept`)
    .set(auth(b.token))
  expect(accept.status).toBe(200)
}

describe("account export isolation", () => {
  // idempotency_keys.actor_id has no FK to users, so idsToUuids never
  // rewrites it and the trainee's export carries the trainer's users.id.
  it("does not hand a trainee their trainer's internal users.id", async () => {
    const trainee = await signup("expte")
    const trainer = await signup("exptr")
    await befriend(trainee, trainer)
    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainer.user.id, permissionType: "trainer" })
    expect(grant.status).toBe(201)

    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", trainee.user.id)
      .set("Idempotency-Key", "audit-export-actor-1")
      .send({ dayNumber: 1, dayTitle: "Day 1" })
    expect(start.status).toBe(200)

    const exported = await request(app)
      .get("/api/auth/account/export")
      .set(auth(trainee.token))
    expect(exported.status).toBe(200)
    const trainerId = await internalId(trainer.user.id)
    const rows = exported.body.data.idempotency_keys as { actor_id: unknown }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.actor_id).not.toBe(trainerId)
  })

  // users.demo_owner_id makes `users` an "owned" table, so the export dumps
  // whole users rows (numeric id, token_version, password_hash) for the
  // caller's demo friends.
  it("does not export raw users rows with internal ids", async () => {
    const owner = await signup("expdm")
    const fill = await request(app)
      .post("/api/sessions/demo")
      .set(auth(owner.token))
      .send({
        split: "Demo",
        days: [{ dayNumber: 1, dayTitle: "Demo", exercises: [{ name: "Bench", sets: 1 }] }],
      })
    expect(fill.status).toBe(200)

    const exported = await request(app)
      .get("/api/auth/account/export")
      .set(auth(owner.token))
    expect(exported.status).toBe(200)
    const users = (exported.body.data.users ?? []) as Record<string, unknown>[]
    for (const u of users) {
      expect(typeof u.id).not.toBe("number")
      expect(u).not.toHaveProperty("password_hash")
      expect(u).not.toHaveProperty("token_version")
    }
  })
})
