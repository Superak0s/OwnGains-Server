import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("personalNotes routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("pnote")
  })

  it("creates notes and reads them per muscle", async () => {
    const ok = await request(app)
      .post("/api/tracking/personal-notes")
      .set(auth(u.token))
      .send({ muscleGroup: "chest", content: "keep elbows tucked" })
    expect(ok.status).toBe(201)

    const chest = await request(app).get("/api/tracking/personal-notes/muscle/chest").set(auth(u.token))
    expect(chest.body.data.length).toBe(1)
    expect(chest.body.data[0].content).toBe("keep elbows tucked")

    const legs = await request(app).get("/api/tracking/personal-notes/muscle/legs").set(auth(u.token))
    expect(legs.body.data.length).toBe(0)
  })

  it("deletes only the caller's own note", async () => {
    const created = await request(app)
      .post("/api/tracking/personal-notes")
      .set(auth(u.token))
      .send({ muscleGroup: "back", content: "brace" })
    const id = created.body.data.id

    const other = await signup("pnote2")
    const notYours = await request(app).delete(`/api/tracking/personal-notes/${id}`).set(auth(other.token))
    expect(notYours.status).toBe(404)

    const del = await request(app).delete(`/api/tracking/personal-notes/${id}`).set(auth(u.token))
    expect(del.status).toBe(200)
    const back = await request(app).get("/api/tracking/personal-notes/muscle/back").set(auth(u.token))
    expect(back.body.data).toHaveLength(0)
  })
})
