import { describe, it, expect } from "vitest"
import {
  errorHandler,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
} from "../errorHandler.js"

function makeRes() {
  return {
    code: 0 as number,
    body: null as any,
    status(code: number) {
      this.code = code
      return this
    },
    json(o: any) {
      this.body = o
      return this
    },
  }
}

const req = { path: "/api/test", method: "GET", reqId: "test" } as any

function handle(err: unknown) {
  const res = makeRes()
  errorHandler(err as never, req, res as never, (() => {}) as never)
  return res
}

describe("errorHandler", () => {
  it("maps AppError subclasses to their status codes", () => {
    let r = handle(new ValidationError("bad input", ["a", "b"]))
    expect(r.code).toBe(400)
    expect(r.body.error).toBe("bad input")
    expect(r.body.details).toEqual(["a", "b"])

    r = handle(new NotFoundError("Widget"))
    expect(r.code).toBe(404)
    expect(r.body.error).toBe("Widget not found")

    r = handle(new UnauthorizedError())
    expect(r.code).toBe(401)
    expect(r.body.error).toBe("Unauthorized")

    r = handle(new ForbiddenError())
    expect(r.code).toBe(403)
    expect(r.body.error).toBe("Access denied")

    r = handle(new ConflictError("taken"))
    expect(r.code).toBe(409)
    expect(r.body.error).toBe("taken")
  })

  it("includes the message and stack for 500s in development", () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "development"
    try {
      const r = handle(new Error("boom"))
      expect(r.code).toBe(500)
      expect(r.body.error).toBe("boom")
      expect(r.body.stack).toBeTruthy()
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it("masks internal errors in production", () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      const r = handle(new Error("secret db failure"))
      expect(r.code).toBe(500)
      expect(r.body.error).toBe("Internal server error")
      expect(r.body.stack).toBeUndefined()
      expect(r.body.details).toBeUndefined()
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})
