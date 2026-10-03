/**
 * Cross-user authorization sweep.
 *
 * One victim creates a row in every user-scoped feature. One attacker, holding
 * a perfectly valid token of their own, then tries to read, mutate and delete
 * each of those rows by id. Every attempt must fail, and the victim's data must
 * still be there afterwards.
 *
 * This is the regression net for IDOR: any new route that forgets its
 * `AND user_id = ?` shows up here as a 200 where a 403/404 belongs.
 */
import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../helpers.js"
import { pool } from "@/config/database.js"

interface Signup {
  username: string
  token: string
  user: { id: string }
}

// A denial is a denial regardless of which code the route picks: some
// tracking deletes report a miss as 400 (ValidationError) rather than 404.
// What matters is that it is never 2xx and the row is still there. See the
// "leaves the victim's data intact" case at the end.
const DENIED = [400, 401, 403, 404]

let victim: Signup
let attacker: Signup

/** ids of the victim's rows, filled in by beforeAll */
const v: Record<string, number> = {}

const iso = (secondsAgo: number) =>
  new Date(Date.now() - secondsAgo * 1000).toISOString()

beforeAll(async () => {
  victim = await signup("victim")
  attacker = await signup("attacker")

  const post = async (url: string, body: object) => {
    const res = await request(app).post(url).set(auth(victim.token)).send(body)
    if (res.status >= 400)
      throw new Error(`victim setup ${url} failed: ${res.status} ${res.text}`)
    return res
  }

  // No route sets height, and the body-fat calculator needs one.
  await pool.execute("UPDATE users SET height_cm = 180 WHERE uuid = ?", [
    victim.user.id,
  ])

  const session = await post("/api/sessions/start", {
    dayNumber: 1,
    dayTitle: "Day 1",
    split: "A",
  })
  v.sessionId = session.body.session.id

  const set = await post(`/api/sessions/${v.sessionId}/set`, {
    exerciseName: "Bench",
    setIndex: 1,
    startTime: iso(60),
    endTime: iso(30),
    weight: 60,
    reps: 8,
  })
  v.setId = set.body.timing.id

  v.weightId = (await post("/api/tracking/bodystats/weight", { weightKg: 70.5 }))
    .body.id
  v.bodyFatId = (
    await post("/api/tracking/bodystats/bodyfat/log", {
      percentage: 15,
      measurements: { waist: 80, neck: 38, unit: "cm" },
    })
  ).body.entry.id
  v.measurementId = (
    await post("/api/tracking/measurements", {
      values: { waist_cm: 81 },
      note: "monday",
    })
  ).body.id
  v.hydrationId = (
    await post("/api/tracking/hydration", { amountMl: 500, note: "morning" })
  ).body.id
  v.sorenessId = (
    await post("/api/tracking/soreness", { muscleGroup: "chest", intensity: 6 })
  ).body.data.id
  v.menstrualId = (
    await post("/api/tracking/menstrual", { cycleStart: "2024-05-01" })
  ).body.data.id
  v.macroId = (
    await post("/api/tracking/macros/log", {
      name: "lunch",
      protein: 20,
      takenAt: "2024-06-01T12:30:00Z",
    })
  ).body.entry.id
  v.supplementId = (
    await post("/api/tracking/supplements", { name: "Vitamin D" })
  ).body.supplement.id
  v.supplementLogId = (
    await post(`/api/tracking/supplements/${v.supplementId}/log`, { amount: 1 })
  ).body.id
  // A metric only this user has defined: the attacker must not be able to
  // write against it, and it must not appear in their definitions list.
  await post("/api/tracking/measurements/definitions", {
    keyName: "grip_kg",
    label: "Grip",
    unit: "kg",
  })

  const photo = await request(app)
    .post("/api/tracking/photos/muscle")
    .set(auth(victim.token))
    .field("muscleGroups", JSON.stringify(["chest"]))
    .field("angle", "front")
    .attach(
      "photo",
      // 1x1 transparent PNG with real magic bytes, so imageUpload accepts it
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
      "p.png",
    )
  expect(photo.status).toBe(201)
  v.photoId = photo.body.id

  await post("/api/program/upload", {
    originalFilename: "plan.xlsx",
    weeklyPlan: {
      split: ["A"],
      days: [
        {
          dayNumber: 1,
          dayTitle: "Day 1",
          exercises: [],
          split: { A: { exercises: [], totalSets: 0 } },
        },
      ],
    },
  })
})

describe("cross-user reads are denied", () => {
  const reads: [string, () => string][] = [
    ["session detail", () => `/api/sessions/${v.sessionId}`],
    ["progress photo image", () => `/api/tracking/photos/muscle/${v.photoId}/image`],
  ]

  it.each(reads)("GET %s", async (_label, url) => {
    const res = await request(app).get(url()).set(auth(attacker.token))
    expect(DENIED).toContain(res.status)
  })

  // [url, key holding the array in the response envelope]
  const lists: [string, string][] = [
    ["/api/sessions", "sessions"],
    ["/api/tracking/bodystats/weight", "entries"],
    ["/api/tracking/bodystats/bodyfat/log", "entries"],
    ["/api/tracking/measurements?metrics=waist_cm", "data"],
    ["/api/tracking/hydration", "data"],
    ["/api/tracking/soreness", "data"],
    ["/api/tracking/soreness/active", "data"],
    ["/api/tracking/menstrual", "data"],
    ["/api/tracking/macros/log", "entries"],
    ["/api/tracking/supplements", "supplements"],
    ["/api/tracking/photos/muscle", "data"],
    ["/api/tracking/measurements/definitions", "data"],
  ]

  it.each(lists)(
    "%s returns only the caller's own rows",
    async (url, key) => {
      const res = await request(app).get(url).set(auth(attacker.token))
      expect(res.status).toBe(200)
      // the attacker created nothing, so any row here came from the victim
      expect(res.body[key]).toEqual([])
    },
  )

  it("attacker's program is untouched by the victim's upload", async () => {
    const res = await request(app).get("/api/program").set(auth(attacker.token))
    expect(res.status).toBe(404)
  })

  it("analytics is scoped to the caller", async () => {
    const res = await request(app).get("/api/analytics").set(auth(attacker.token))
    expect(res.status).toBe(200)
    expect(res.body.totalSessions).toBe(0)
    expect(res.body.totalSetsCompleted).toBe(0)
  })
})

describe("cross-user writes and deletes are denied", () => {
  const mutations: [string, () => Promise<{ status: number }>][] = [
    [
      "record a set on someone else's session",
      () =>
        request(app)
          .post(`/api/sessions/${v.sessionId}/set`)
          .set(auth(attacker.token))
          .send({
            exerciseName: "Steal",
            setIndex: 9,
            startTime: iso(60),
            endTime: iso(30),
            weight: 1,
            reps: 1,
          }),
    ],
    [
      "edit someone else's set",
      () =>
        request(app)
          .patch(`/api/sessions/${v.sessionId}/sets/${v.setId}`)
          .set(auth(attacker.token))
          .send({ weight: 999 }),
    ],
    [
      "end someone else's session",
      () =>
        request(app)
          .post(`/api/sessions/${v.sessionId}/end`)
          .set(auth(attacker.token))
          .send({}),
    ],
    [
      "delete someone else's photo",
      () =>
        request(app)
          .delete(`/api/tracking/photos/muscle/${v.photoId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's weight entry",
      () =>
        request(app)
          .delete(`/api/tracking/bodystats/weight/${v.weightId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's body-fat entry",
      () =>
        request(app)
          .delete(`/api/tracking/bodystats/bodyfat/log/${v.bodyFatId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's measurement",
      () =>
        request(app)
          .delete(`/api/tracking/measurements/${v.measurementId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's hydration entry",
      () =>
        request(app)
          .delete(`/api/tracking/hydration/${v.hydrationId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's soreness entry",
      () =>
        request(app)
          .delete(`/api/tracking/soreness/${v.sorenessId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's menstrual entry",
      () =>
        request(app)
          .delete(`/api/tracking/menstrual/${v.menstrualId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's macro entry",
      () =>
        request(app)
          .delete(`/api/tracking/macros/log/${v.macroId}`)
          .set(auth(attacker.token)),
    ],
    [
      "follow up on someone else's soreness entry",
      () =>
        request(app)
          .post(`/api/tracking/soreness/${v.sorenessId}/follow-ups`)
          .set(auth(attacker.token))
          .send({ intensity: 1, status: "recovered" }),
    ],
    [
      "rename someone else's supplement",
      () =>
        request(app)
          .patch(`/api/tracking/supplements/${v.supplementId}`)
          .set(auth(attacker.token))
          .send({ name: "Owned" }),
    ],
    [
      "delete someone else's supplement",
      () =>
        request(app)
          .delete(`/api/tracking/supplements/${v.supplementId}`)
          .set(auth(attacker.token)),
    ],
    [
      "delete someone else's supplement log entry",
      () =>
        request(app)
          .delete(
            `/api/tracking/supplements/${v.supplementId}/log/${v.supplementLogId}`,
          )
          .set(auth(attacker.token)),
    ],
    [
      "log a value against someone else's metric definition",
      () =>
        request(app)
          .post("/api/tracking/measurements")
          .set(auth(attacker.token))
          .send({ values: { grip_kg: 1 } }),
    ],
  ]

  it.each(mutations)("%s", async (_label, attack) => {
    const res = await attack()
    expect(DENIED).toContain(res.status)
  })

  it("leaves the victim's data intact after the whole sweep", async () => {
    const session = await request(app)
      .get(`/api/sessions/${v.sessionId}`)
      .set(auth(victim.token))
    expect(session.status).toBe(200)
    // still open, and the attacker's set was never written
    expect(session.body.session.endTime).toBeNull()
    expect(session.body.session.setTimings).toHaveLength(1)
    expect(session.body.session.setTimings[0].weight).toBe(60)

    const photo = await request(app)
      .get(`/api/tracking/photos/muscle/${v.photoId}/image`)
      .set(auth(victim.token))
    expect(photo.status).toBe(200)

    const list = await request(app)
      .get("/api/tracking/supplements")
      .set(auth(victim.token))
    expect(list.status).toBe(200)
    const kept = list.body.supplements.find((s: any) => s.id === v.supplementId)
    expect(kept?.name).toBe("Vitamin D")

    const log = await request(app)
      .get(`/api/tracking/supplements/${v.supplementId}/log`)
      .set(auth(victim.token))
    expect(log.status).toBe(200)
  })
})

describe("social boundaries", () => {
  it("refuses to read a non-friend's sessions", async () => {
    const res = await request(app)
      .get(`/api/sharing/sessions/friend/${victim.user.id}`)
      .set(auth(attacker.token))
    expect(res.status).toBe(403)
  })

  it("refuses to watch a non-friend's live session", async () => {
    const res = await request(app)
      .get(`/api/sharing/watch/friend/${victim.user.id}/active`)
      .set(auth(attacker.token))
    expect(res.status).toBe(403)
  })

  it("being friends is not enough: history needs an explicit grant", async () => {
    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(attacker.token))
      .send({ username: victim.username })
    expect(req.status).toBe(201)
    await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/accept`)
      .set(auth(victim.token))

    const res = await request(app)
      .get(`/api/sharing/sessions/friend/${victim.user.id}`)
      .set(auth(attacker.token))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/history access/)
  })

  it("cannot accept or reject a friend request addressed to someone else", async () => {
    const third = await signup("third")
    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(third.token))
      .send({ username: victim.username })
    expect(req.status).toBe(201)

    const accept = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/accept`)
      .set(auth(attacker.token))
    expect(accept.status).toBe(404)

    const reject = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/reject`)
      .set(auth(attacker.token))
    expect(reject.status).toBe(404)
  })

  it("cannot revoke a permission it does not own", async () => {
    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(victim.token))
      .send({ friendId: attacker.user.id, permissionType: "analytics" })
    expect(grant.status).toBe(201)

    // the grantee is not the grantor: only the grantor may revoke
    const res = await request(app)
      .delete(`/api/sharing/permissions/${grant.body.permissionId}`)
      .set(auth(attacker.token))
    expect(res.status).toBe(404)
  })

  it("cannot push progress into a joint session it is not part of", async () => {
    const res = await request(app)
      .patch("/api/sharing/joint-sessions/999999/progress")
      .set(auth(attacker.token))
      .send({ exerciseIndex: 0, setIndex: 0 })
    expect(res.status).toBe(404)
  })
})

describe("trainer mode stays inside its routers", () => {
  // A real trainer grant, so the header is actually honoured on /api/sessions.
  let trainee: Signup
  let trainer: Signup

  beforeAll(async () => {
    trainee = await signup("tmtrainee")
    trainer = await signup("tmtrainer")

    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(trainee.token))
      .send({ username: trainer.username })
    await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/accept`)
      .set(auth(trainer.token))
    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainer.user.id, permissionType: "trainer" })
    expect(grant.status).toBe(201)

    // trainee logs private tracking data the trainer must never see
    await request(app)
      .post("/api/tracking/bodystats/weight")
      .set(auth(trainee.token))
      .send({ weightKg: 61.2 })
    await request(app)
      .post("/api/tracking/menstrual")
      .set(auth(trainee.token))
      .send({ cycleStart: "2024-05-01" })
  })

  it("honours the header on /api/sessions (control)", async () => {
    const res = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
    expect(res.status).toBe(200)
  })

  const offLimits: [string, string][] = [
    ["/api/tracking/bodystats/weight", "entries"],
    ["/api/tracking/menstrual", "data"],
    ["/api/tracking/photos/muscle", "data"],
    ["/api/tracking/measurements?metrics=waist_cm", "data"],
    ["/api/tracking/hydration", "data"],
  ]

  it.each(offLimits)(
    "a trainer grant does not reach %s",
    async (url, key) => {
      const res = await request(app)
        .get(url)
        .set(auth(trainer.token))
        .set("X-Trainee-Id", String(trainee.user.id))
      expect(res.status).toBe(200)
      // header is ignored here: the trainer sees their own empty data
      expect(res.body[key]).toEqual([])
    },
  )

  it("a trainer cannot grant permissions on the trainee's behalf", async () => {
    const outsider = await signup("outsider")
    // Trainer tries to make the trainee share history with a third party.
    const res = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({ friendId: outsider.user.id, permissionType: "history" })
    // /api/sharing has no trainer context: this is evaluated as the trainer,
    // who is not friends with the outsider, so it is refused outright.
    expect(res.status).toBe(403)

    const granted = await request(app)
      .get("/api/sharing/permissions/granted")
      .set(auth(trainee.token))
    expect(
      granted.body.permissions.some(
        (p: { toUserId: string }) => p.toUserId === outsider.user.id,
      ),
    ).toBe(false)
  })
})

describe("PII disclosure", () => {
  it("does not expose an email address to someone who merely sent a friend request", async () => {
    const target = await signup("pii")
    const stranger = await signup("stranger")

    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(stranger.token))
      .send({ username: target.username })
    expect(req.status).toBe(201)

    // target has NOT accepted, so the stranger must not learn their email
    const sent = await request(app)
      .get("/api/friends/requests/sent")
      .set(auth(stranger.token))
    expect(sent.status).toBe(200)
    const row = sent.body.requests.find(
      (r: { username: string }) => r.username === target.username,
    )
    expect(row).toBeDefined()
    expect(row.email).toBeUndefined()
  })

  it("does not expose emails in the pending-request list either", async () => {
    const target = await signup("pii2")
    const stranger = await signup("stranger2")

    await request(app)
      .post("/api/friends/request")
      .set(auth(stranger.token))
      .send({ username: target.username })

    const pending = await request(app)
      .get("/api/friends/requests/pending")
      .set(auth(target.token))
    expect(pending.status).toBe(200)
    expect(JSON.stringify(pending.body)).not.toContain("@test.local")
  })

  it("does not expose emails in the friends list", async () => {
    // victim and attacker became friends in the "social boundaries" block
    const res = await request(app).get("/api/friends").set(auth(attacker.token))
    expect(res.status).toBe(200)
    expect(res.body.friends.length).toBeGreaterThan(0)
    expect(JSON.stringify(res.body)).not.toContain("@test.local")
  })

  it("does not expose emails in user search", async () => {
    const res = await request(app)
      .get(`/api/friends/search?q=${victim.username.slice(0, 6)}`)
      .set(auth(attacker.token))
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain("@test.local")
  })
})
