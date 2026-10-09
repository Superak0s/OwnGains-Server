// The middleware on a bare app, for what the session routes never do: answer
// without res.json, send no body, or hit a database error mid-claim.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import express from "express"
import request from "supertest"
import { signup, internalId } from "../../tests/helpers.js"
import { pool } from "../../config/database.js"
import { logger } from "../../utils/logger.js"
import { idempotent } from "../idempotency.js"

afterEach(() => vi.restoreAllMocks())

let userId: number
const app = express()
app.use((req, _res, next) => {
  req.user = { id: userId } as never
  next()
})
app.post("/ok", idempotent, (_req, res) => void res.status(201).json({ ok: true }))
app.post("/bad", idempotent, (_req, res) => void res.status(400).json({ error: "no" }))
app.post("/raw", idempotent, (_req, res) => void res.send("raw"))
app.use(((err, _req, res, _next) => void res.status(err.statusCode ?? 500).json({ message: err.message })) as express.ErrorRequestHandler)

const key = () => `edge-${crypto.randomUUID()}`
const realExecute = pool.execute.bind(pool)
/** Fails statements that start with `prefix`, every time, with `err`. */
const fail = (prefix: string, err: object) =>
  vi.spyOn(pool, "execute").mockImplementation(((sql: string, p: unknown) =>
    sql.trimStart().startsWith(prefix) ? Promise.reject(Object.assign(new Error("injected"), err)) : realExecute(sql, p as never)) as never)

beforeAll(async () => {
  userId = await internalId((await signup("idemedge")).user.id)
})

describe("idempotency middleware edges", () => {
  it("replays a request that had no body", async () => {
    const k = key()
    await request(app).post("/ok").set("Idempotency-Key", k).expect(201)
    expect((await request(app).post("/ok").set("Idempotency-Key", k).expect(201)).body).toEqual({ ok: true })
  })

  it("releases the key of a handler that answers without res.json", async () => {
    const k = key()
    await request(app).post("/raw").set("Idempotency-Key", k).expect(200)
    await vi.waitFor(async () => {
      const [rows] = await pool.query<never[]>(`SELECT 1 FROM idempotency_keys WHERE user_id = ? AND idem_key = ?`, [userId, k])
      expect(rows).toHaveLength(0)
    })
  })

  it("passes a database error on the claim through", async () => {
    fail("INSERT INTO idempotency_keys", { code: "ER_LOCK_DEADLOCK" })
    await request(app).post("/ok").set("Idempotency-Key", key()).expect(500)
  })

  it("claims again when the conflicting row is gone by the time it is read", async () => {
    let first = true
    vi.spyOn(pool, "execute").mockImplementation(((sql: string, p: unknown) => {
      if (first && sql.trimStart().startsWith("INSERT INTO idempotency_keys")) {
        first = false
        return Promise.reject(Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" }))
      }
      return realExecute(sql, p as never)
    }) as never)
    await request(app).post("/ok").set("Idempotency-Key", key()).expect(201)
  })

  it("still answers when storing or releasing the key fails", async () => {
    const warn = vi.spyOn(logger, "warn")
    fail("UPDATE idempotency_keys", { code: "ER_LOCK_DEADLOCK" })
    await request(app).post("/ok").set("Idempotency-Key", key()).expect(201)
    vi.restoreAllMocks()
    const warn2 = vi.spyOn(logger, "warn")
    fail("DELETE FROM idempotency_keys", { code: "ER_LOCK_DEADLOCK" })
    await request(app).post("/bad").set("Idempotency-Key", key()).expect(400)
    expect(warn).toHaveBeenCalledWith("[IDEMPOTENCY] store failed:", "injected")
    expect(warn2).toHaveBeenCalledWith("[IDEMPOTENCY] release failed:", "injected")
  })
})
