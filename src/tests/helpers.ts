import request from "supertest"
import { app } from "../server.js"
import { findUserByUuid } from "../features/auth/auth.model.js"
import { main } from "../owngains.js"

export { app }

let n = 0
// Random, not a timestamp: parallel workers can start in the same millisecond.
const stamp = Math.random().toString(36).slice(2, 7)

export function uniqueName(prefix: string): string {
  n += 1
  return `${prefix}_${stamp}${n}`.slice(0, 20)
}

export async function signup(prefix = "user", password = "Passw0rd-123") {
  const username = uniqueName(prefix)
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ username, email: `${username}@test.local`, password, termsVersion: "test", healthConsent: true })
  if (res.status !== 201)
    throw new Error(`signup ${username} failed: ${res.status} ${res.text}`)
  return { username, token: res.body.token, user: res.body.user, password }
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` }
}

// Sends a friend request from `a` to `b` and accepts it as `b`.
export async function befriend(a: { token: string }, b: { token: string; username: string }) {
  const req = await request(app)
    .post("/api/friends/request")
    .set(auth(a.token))
    .send({ username: b.username })
  if (req.status !== 201)
    throw new Error(`friend request failed: ${req.status} ${req.text}`)
  const accept = await request(app)
    .post(`/api/friends/request/${req.body.friendshipId}/accept`)
    .set(auth(b.token))
  if (accept.status !== 200)
    throw new Error(`friend accept failed: ${accept.status} ${accept.text}`)
}

// API responses contain the public uuid. Tests that query tables directly need
// the internal users.id the foreign keys point at.
export async function internalId(uuid: string): Promise<number> {
  const user = await findUserByUuid(uuid)
  if (!user) throw new Error(`no user with uuid ${uuid}`)
  return user.id
}

// Runs the operator CLI in-process, capturing what it prints.
export async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => logs.push(a.join(" "))
  console.error = (...a: unknown[]) => logs.push(a.join(" "))
  const prev = process.argv
  process.argv = ["node", "owngains", ...args]
  try {
    return { code: await main(), out: logs.join("\n") }
  } finally {
    console.log = origLog
    console.error = origErr
    process.argv = prev
  }
}
