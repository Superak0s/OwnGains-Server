// Session route paths that need another socket open or a failing audience
// read, with the WS layer mocked so no real socket is needed.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import request from "supertest"
import { app, signup, auth, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import { logger } from "../../../utils/logger.js"
import { sendFriendRequest, acceptFriendRequest } from "../../social/friends/friends.model.js"
import { grantPermission } from "../../social/sharing/sharing.model.js"

const ws = vi.hoisted(() => ({ sendToUser: vi.fn(), hasOtherClients: vi.fn(() => true) }))
vi.mock("../../../ws/wsServer.js", async (orig) => ({ ...(await orig<object>()), ...ws }))

afterEach(() => vi.restoreAllMocks())

let lifter: Awaited<ReturnType<typeof signup>>
let watcher: Awaited<ReturnType<typeof signup>>
const failAudience = () => {
  const real = pool.execute.bind(pool)
  vi.spyOn(pool, "execute").mockImplementation(((sql: string, p: unknown) =>
    sql.includes("sp.permission_type IN") ? Promise.reject(new Error("audience down")) : real(sql, p as never)) as never)
}
const start = () => request(app).post("/api/sessions/start").set(auth(lifter.token)).send({ dayNumber: 2, dayTitle: "Edge" })

beforeAll(async () => {
  ;[lifter, watcher] = [await signup("wrl"), await signup("wrw")]
  const [l, w] = [await internalId(lifter.user.id), await internalId(watcher.user.id)]
  await acceptFriendRequest(w, await sendFriendRequest(l, w))
  await grantPermission(l, w, "watch_session")
})

describe("session route edges", () => {
  it("pushes a set with no weight or reps to a watcher", async () => {
    const id = (await start()).body.session.id
    await request(app)
      .post(`/api/sessions/${id}/set`)
      .set(auth(lifter.token))
      .send({ exerciseName: "EdgeDip", setIndex: 0, startTime: "2026-01-01T10:00:00Z", endTime: "2026-01-01T10:01:00Z" })
      .expect(200)
    await vi.waitFor(() =>
      expect(ws.sendToUser).toHaveBeenCalledWith(watcher.user.id, "live_set_recorded", {
        sessionId: id,
        set: expect.objectContaining({ weight: 0, reps: 0 }),
      }),
    )
  })

  it("logs a failed audience read instead of failing the write", async () => {
    const warn = vi.spyOn(logger, "warn")
    failAudience()
    const id = (await start().expect(200)).body.session.id
    await request(app)
      .post(`/api/sessions/${id}/set`)
      .set(auth(lifter.token))
      .send({ exerciseName: "EdgeDip", setIndex: 1, startTime: "2026-01-01T10:02:00Z", endTime: "2026-01-01T10:03:00Z", weight: 5, reps: 5 })
      .expect(200)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[WS] live set push failed:", "audience down"))
    expect(warn).toHaveBeenCalledWith("[WS] pushSessionStatusToWatchers failed:", "audience down")
  })

  it("validates a day move, a rename and a day filter", async () => {
    const id = (await start()).body.session.id
    await request(app).patch(`/api/sessions/${id}`).set(auth(lifter.token)).expect(400)
    await request(app).patch(`/api/sessions/${id}`).set(auth(lifter.token)).send({ dayNumber: 1, dayTitle: 5 }).expect(400)
    await request(app)
      .post("/api/sessions/rename-exercise")
      .set(auth(lifter.token))
      .send({ split: "s", oldName: "a", newName: " " })
      .expect(400)
    const { body } = await request(app).get("/api/sessions?dayNumber=2").set(auth(lifter.token)).expect(200)
    expect(body.sessions.every((s: { dayNumber: number }) => s.dayNumber === 2)).toBe(true)
  })
})
