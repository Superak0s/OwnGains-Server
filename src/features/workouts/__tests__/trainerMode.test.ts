import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import http from "http"
import request from "supertest"
import WebSocket from "ws"
import { app, signup, auth } from "../../../tests/helpers.js"
import { createWsServer } from "../../../ws/wsServer.js"
import { pool } from "@/config/database.js"

interface Signup {
  username: string
  token: string
  user: { id: string }
}

const minimalProgram = {
  split: ["A"],
  days: [
    {
      dayNumber: 1,
      dayTitle: "Day 1",
      exercises: [],
      split: { A: { exercises: [], totalSets: 0 } },
    },
  ],
}

describe("trainer mode", () => {
  let trainee: Signup
  let trainer: Signup

  beforeAll(async () => {
    trainee = await signup("trainee")
    trainer = await signup("trainer")

    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(trainee.token))
      .send({ username: trainer.username })
    expect(req.status).toBe(201)
    const accept = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/accept`)
      .set(auth(trainer.token))
    expect(accept.status).toBe(200)

    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainer.user.id, permissionType: "trainer" })
    expect(grant.status).toBe(201)
  })

  it("refuses to act as a suspended trainee", async () => {
    const before = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", trainee.user.id)
    expect(before.status).toBe(200)

    await pool.query("UPDATE users SET disabled_at = NOW() WHERE uuid = ?", [trainee.user.id])
    try {
      const during = await request(app)
        .get("/api/sessions")
        .set(auth(trainer.token))
        .set("X-Trainee-Id", trainee.user.id)
      expect(during.status).toBe(403)
      expect(during.body.error).toBe("NOT_A_TRAINER")
    } finally {
      await pool.query("UPDATE users SET disabled_at = NULL WHERE uuid = ?", [trainee.user.id])
    }
  })

  it("rejects X-Trainee-Id without an active grant", async () => {
    const stranger = await signup("stranger")

    const unknown = await request(app)
      .get("/api/sessions")
      .set(auth(stranger.token))
      .set("X-Trainee-Id", randomUUID())
    expect(unknown.status).toBe(403)
    expect(unknown.body.error).toBe("NOT_A_TRAINER")

    const noGrant = await request(app)
      .get("/api/sessions")
      .set(auth(stranger.token))
      .set("X-Trainee-Id", String(trainee.user.id))
    expect(noGrant.status).toBe(403)
    expect(noGrant.body.error).toBe("NOT_A_TRAINER")

    const malformed = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", "not-a-number")
    expect(malformed.status).toBe(403)
    expect(malformed.body.error).toBe("NOT_A_TRAINER")
  })

  it("403s again once the grant is revoked", async () => {
    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainer.user.id, permissionType: "analytics" })
    expect(grant.status).toBe(201)
    await request(app)
      .delete(`/api/sharing/permissions/${grant.body.permissionId}`)
      .set(auth(trainee.token))
    // sanity: revoking one type doesn't touch the trainer grant
    const res = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
    expect(res.status).toBe(200)
  })

  it("scopes reads and writes to the trainee when the header is present", async () => {
    // Trainer starts a session. It must be created on the trainee's account.
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({ dayNumber: 1, dayTitle: "Day 1", split: "A" })
    expect(start.status).toBe(200)
    const sessionId = start.body.session.id

    const traineeSessions = await request(app)
      .get("/api/sessions")
      .set(auth(trainee.token))
    expect(traineeSessions.body.sessions.some((s: any) => s.id === sessionId)).toBe(true)

    const trainerOwn = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
    expect(trainerOwn.body.sessions.some((s: any) => s.id === sessionId)).toBe(false)

    // End it the same way, still through the header.
    const end = await request(app)
      .post(`/api/sessions/${sessionId}/end`)
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({})
    expect(end.status).toBe(200)

    // Same for the program: trainer operates on the trainee's program.
    const upload = await request(app)
      .post("/api/program/upload")
      .set(auth(trainee.token))
      .send({ originalFilename: "plan.xlsx", weeklyPlan: minimalProgram })
    expect(upload.status).toBe(200)

    const add = await request(app)
      .patch("/api/program/exercise/add")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({ dayNumber: 1, split: "A", exercise: { name: "Bench", sets: 4, reps: "8-12" } })
    expect(add.status).toBe(200)
    expect(add.body.exercise.reps).toBe("8-12")

    // Machine settings are the one program edit trainer mode performs. The
    // granular route allows it, but /upload (a whole-program replace) must not.
    const machine = await request(app)
      .patch("/api/program/exercise/machine")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({
        dayNumber: 1,
        split: "A",
        exerciseIndex: 0,
        patch: { machines: ["Smith"], selectedMachine: "Smith" },
      })
    expect(machine.status).toBe(200)

    const blockedUpload = await request(app)
      .post("/api/program/upload")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({ originalFilename: "evil.xlsx", weeklyPlan: minimalProgram })
    expect(blockedUpload.status).toBe(403)

    // The whitelist is what keeps the granular route from becoming /upload.
    const smuggled = await request(app)
      .patch("/api/program/exercise/machine")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({
        dayNumber: 1,
        split: "A",
        exerciseIndex: 0,
        patch: { selectedMachine: "Smith", sets: 999, name: "Curls" },
      })
    expect(smuggled.status).toBe(400)

    const get = await request(app)
      .get("/api/program")
      .set(auth(trainee.token))
    expect(get.body.days[0].split.A.exercises[0].name).toBe("Bench")
    expect(get.body.days[0].split.A.exercises[0].reps).toBe("8-12")

    // Without the header the trainer sees their own (empty) state.
    const trainerProgram = await request(app)
      .get("/api/program")
      .set(auth(trainer.token))
    expect(trainerProgram.status).toBe(404)
  })

  it("refuses destructive routes in trainer mode, but not for the trainee", async () => {
    for (const url of ["/api/sessions/split/A", "/api/sessions/demo", "/api/program"]) {
      const res = await request(app)
        .delete(url)
        .set(auth(trainer.token))
        .set("X-Trainee-Id", String(trainee.user.id))
      expect(res.status).toBe(403)
    }

    // The trainee's data is untouched, and they can still delete it themselves.
    const program = await request(app).get("/api/program").set(auth(trainee.token))
    expect(program.status).toBe(200)

    const own = await request(app).delete("/api/program").set(auth(trainee.token))
    expect(own.status).toBe(200)
  })

  it("ignores X-Trainee-Id on /api/auth", async () => {
    const me = await request(app)
      .get("/api/auth/me")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
    expect(me.status).toBe(200)
    expect(me.body.user.username).toBe(trainer.username)
  })
})

describe("trainer mode WS events", () => {
  let server: http.Server
  let port: number
  let trainee: Signup
  let trainer: Signup
  const sockets: WebSocket[] = []

  async function connect(token: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", reject)
    })
    ws.send(JSON.stringify({ type: "auth", token }))
    // "authed" is the server's ack. Any other message means auth failed.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for auth ack")), 5000)
      ws.once("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        clearTimeout(t)
        msg.type === "auth_success" ? resolve() : reject(new Error(`auth failed: ${msg.type}`))
      })
    })
    sockets.push(ws)
    return ws
  }

  function expectMessage(ws: WebSocket, type: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000)
      const onMessage = (raw: Buffer) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type !== type) return
        clearTimeout(t)
        ws.off("message", onMessage)
        resolve(msg)
      }
      ws.on("message", onMessage)
    })
  }

  beforeAll(async () => {
    trainee = await signup("wstrainee")
    trainer = await signup("wstrainer")

    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(trainee.token))
      .send({ username: trainer.username })
    expect(req.status).toBe(201)
    const accept = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/accept`)
      .set(auth(trainer.token))
    expect(accept.status).toBe(200)
    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainer.user.id, permissionType: "trainer" })
    expect(grant.status).toBe(201)

    server = http.createServer(app)
    createWsServer(server)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as any).port

    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(trainee.token))
      .send({ dayNumber: 1, dayTitle: "Day 1", split: "A" })
    expect(start.status).toBe(200)
    ;(globalThis as any).__sessionId = start.body.session.id
  })

  afterAll(async () => {
    sockets.forEach((ws) => ws.close())
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("trainer_set_recorded → trainee; trainee_set_recorded → trainer", async () => {
    const sessionId = (globalThis as any).__sessionId
    const traineeWs = await connect(trainee.token)
    const trainerWs = await connect(trainer.token)

    const now = new Date()
    const iso = (offsetSec: number) =>
      new Date(now.getTime() - offsetSec * 1000).toISOString()

    // Attach listeners BEFORE the triggering requests: the server pushes the
    // WS event mid-request, before the HTTP response resolves.
    const toTrainee = expectMessage(traineeWs, "trainer_set_recorded")
    const toTrainer = expectMessage(trainerWs, "trainee_set_recorded")

    // Trainer records a set on the trainee's session → trainee is told.
    const trainerRecord = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({
        exerciseName: "Bench",
        setIndex: 1,
        startTime: iso(60),
        endTime: iso(30),
        weight: 60,
        reps: 8,
      })
    expect(trainerRecord.status).toBe(200)

    const traineeReceived = await toTrainee
    expect(traineeReceived.traineeId).toBe(trainee.user.id)
    expect(traineeReceived.trainerId).toBe(trainer.user.id)
    expect(traineeReceived.trainerUsername).toBe(trainer.username)
    expect(traineeReceived.sessionId).toBe(sessionId)

    // Trainee records their own set → every trainer with a grant is told.
    const traineeRecord = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(trainee.token))
      .send({
        exerciseName: "Bench",
        setIndex: 2,
        startTime: iso(10),
        endTime: iso(2),
        weight: 60,
        reps: 10,
      })
    expect(traineeRecord.status).toBe(200)

    const trainerReceived = await toTrainer
    expect(trainerReceived.traineeId).toBe(trainee.user.id)
    expect(trainerReceived.trainerId).toBe(trainer.user.id)
    expect(trainerReceived.sessionId).toBe(sessionId)
  })

  it("trainer_session_started / trainer_session_ended → both sides", async () => {
    const traineeWs = await connect(trainee.token)
    const trainerWs = await connect(trainer.token)

    // Same race as above: listen before the request that triggers the push.
    const startedTrainer = expectMessage(trainerWs, "trainer_session_started")
    const startedTrainee = expectMessage(traineeWs, "trainer_session_started")

    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({ dayNumber: 1, dayTitle: "Day 1", split: "A" })
    expect(start.status).toBe(200)
    const sessionId = start.body.session.id

    const gotStartedTrainer = await startedTrainer
    const gotStartedTrainee = await startedTrainee
    for (const msg of [gotStartedTrainer, gotStartedTrainee]) {
      expect(msg.traineeId).toBe(trainee.user.id)
      expect(msg.trainerId).toBe(trainer.user.id)
      expect(msg.trainerUsername).toBe(trainer.username)
      expect(msg.sessionId).toBe(sessionId)
    }

    const endedTrainer = expectMessage(trainerWs, "trainer_session_ended")
    const endedTrainee = expectMessage(traineeWs, "trainer_session_ended")

    const end = await request(app)
      .post(`/api/sessions/${sessionId}/end`)
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(trainee.user.id))
      .send({})
    expect(end.status).toBe(200)

    const gotEndedTrainer = await endedTrainer
    const gotEndedTrainee = await endedTrainee
    expect(gotEndedTrainer.sessionId).toBe(sessionId)
    expect(gotEndedTrainee.sessionId).toBe(sessionId)
  })
})
