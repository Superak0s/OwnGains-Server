#!/usr/bin/env node
// End-to-end smoke test against a running server, over real HTTP and WebSocket,
// using the request shapes the app sends. It signs up a throwaway account and
// deletes it again at the end, so it is safe to point at a live instance.
//
//   node scripts/smoke.mjs [baseUrl] [--min-version x.y.z]
//   pnpm smoke http://localhost:5000
//
// Exit 0 when every check passes, 1 otherwise.

import { randomUUID } from "node:crypto"
import WebSocket from "ws"

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args.splice(i, 2)[1]
}
const minVersion = flag("--min-version")
const base = (args[0] || process.env.SMOKE_URL || "http://localhost:5000").replace(/\/+$/, "")

const color = process.stdout.isTTY
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const pass = (s) => console.log(`  ${paint(32, "✓")} ${s}`)
const fail = (s) => console.log(`  ${paint(31, "✗")} ${s}`)

class CheckError extends Error {}
function expect(cond, message) {
  if (!cond) throw new CheckError(message)
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Left null: the status check that follows reports the failure.
  }
  return { status: res.status, body: json, text }
}

function expectStatus(res, status, what) {
  expect(
    res.status === status,
    `${what}: expected ${status}, got ${res.status} ${res.text.slice(0, 200)}`,
  )
}

function compareVersions(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function wsAuth(token) {
  const url = base.replace(/^http/, "ws") + "/ws"
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new CheckError("WebSocket: no auth reply within 5s"))
    }, 5000)
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })))
    ws.on("message", (data) => {
      clearTimeout(timer)
      ws.close()
      try {
        resolve(JSON.parse(String(data)))
      } catch {
        reject(new CheckError(`WebSocket: non-JSON reply ${String(data).slice(0, 100)}`))
      }
    })
    ws.on("close", (code, reason) => {
      clearTimeout(timer)
      reject(new CheckError(`WebSocket closed before auth reply: ${code} ${reason}`))
    })
    ws.on("error", (err) => {
      clearTimeout(timer)
      reject(new CheckError(`WebSocket: ${err.message}`))
    })
  })
}

const username = `smoke_${randomUUID().replace(/-/g, "").slice(0, 12)}`
const password = `Smoke-${randomUUID()}-1`
const state = { token: null, refreshToken: null, uuid: null, sessionId: null, setId: null }

const weeklyPlan = {
  split: ["push"],
  days: [
    {
      dayNumber: 1,
      dayTitle: "Push Day",
      exercises: [
        { name: "Bench Press", primaryMuscles: ["chest"], secondaryMuscles: [], setsBySplit: { push: 3 } },
      ],
      split: { push: { exercises: [{ name: "Bench Press", sets: 3 }], totalSets: 3 } },
    },
  ],
}

const steps = [
  ["GET /healthz is up and lists local-only features", async () => {
    const r = await call("GET", "/healthz")
    expectStatus(r, 200, "healthz")
    expect(r.body?.status === "OK", `healthz status is ${r.body?.status}`)
    expect(Array.isArray(r.body?.localOnlyFeatures), "healthz.localOnlyFeatures is not an array")
    state.localOnly = r.body.localOnlyFeatures
  }],
  ["unknown routes answer JSON 404", async () => {
    const r = await call("GET", "/api/definitely-not-a-route")
    expectStatus(r, 404, "unknown route")
    expect(r.body?.success === false, "404 body is not { success: false }")
  }],
  ["protected routes refuse a missing token", async () => {
    expectStatus(await call("GET", "/api/auth/me"), 401, "GET /api/auth/me without token")
  }],
  ["POST /api/auth/signup creates an account", async () => {
    const r = await call("POST", "/api/auth/signup", {
      body: { username, email: `${username}@example.com`, password, name: "Smoke Test", termsVersion: "smoke", healthConsent: true },
    })
    expectStatus(r, 201, "signup")
    expect(r.body?.token && r.body?.refreshToken, "signup did not return token + refreshToken")
    expect(typeof r.body?.user?.id === "string", "signup user has no id")
    state.uuid = r.body.user.id
  }],
  ["POST /api/auth/signin issues tokens; bad password is 401", async () => {
    expectStatus(
      await call("POST", "/api/auth/signin", { body: { username, password: "Wrong-password-1" } }),
      401,
      "signin with wrong password",
    )
    const r = await call("POST", "/api/auth/signin", { body: { username, password } })
    expectStatus(r, 200, "signin")
    expect(r.body?.user?.id === state.uuid, "signin returned a different user")
    state.token = r.body.token
    state.refreshToken = r.body.refreshToken
  }],
  ["GET /api/auth/me returns the signed-in user", async () => {
    const r = await call("GET", "/api/auth/me", { token: state.token })
    expectStatus(r, 200, "me")
    expect(r.body?.user?.username === username, "me returned the wrong username")
  }],
  [`GET /api/version${minVersion ? ` is at least ${minVersion} (app's MIN_SERVER_VERSION)` : ""}`, async () => {
    const r = await call("GET", "/api/version", { token: state.token })
    expectStatus(r, 200, "version")
    expect(typeof r.body?.version === "string", "version missing")
    if (minVersion)
      expect(
        compareVersions(r.body.version, minVersion) >= 0,
        `server ${r.body.version} is older than the app's floor ${minVersion}`,
      )
  }],
  ["POST /api/auth/refresh rotates, and a replayed refresh token is refused", async () => {
    const r = await call("POST", "/api/auth/refresh", { body: { refreshToken: state.refreshToken } })
    expectStatus(r, 200, "refresh")
    expect(r.body?.token && r.body?.refreshToken, "refresh did not return a new pair")
    expect(r.body.refreshToken !== state.refreshToken, "refresh token was not rotated")
    const replay = await call("POST", "/api/auth/refresh", { body: { refreshToken: state.refreshToken } })
    expectStatus(replay, 401, "replayed refresh token")
    // Reuse detection may revoke the whole family, so sign in afresh.
    const again = await call("POST", "/api/auth/signin", { body: { username, password } })
    expectStatus(again, 200, "signin after refresh check")
    state.token = again.body.token
    state.refreshToken = again.body.refreshToken
  }],
  ["GET /api/settings answers", async () => {
    const r = await call("GET", "/api/settings", { token: state.token })
    expectStatus(r, 200, "settings get")
  }],
  ["program upload → read → delete", async () => {
    expectStatus(await call("GET", "/api/program", { token: state.token }), 404, "program before upload")
    const up = await call("POST", "/api/program/upload", {
      token: state.token,
      body: { weeklyPlan, originalFilename: "smoke.csv" },
    })
    expectStatus(up, 200, "program upload")
    const got = await call("GET", "/api/program", { token: state.token })
    expectStatus(got, 200, "program get")
    expect(got.body?.days?.[0]?.dayNumber === 1, "program did not round-trip its days")
    expectStatus(await call("DELETE", "/api/program", { token: state.token }), 200, "program delete")
    expectStatus(await call("GET", "/api/program", { token: state.token }), 404, "program after delete")
  }],
  ["POST /api/sessions/start is idempotent under a replayed Idempotency-Key", async () => {
    const key = randomUUID()
    const body = { dayNumber: 1, dayTitle: "Push Day", split: "push", startTime: new Date(Date.now() - 60000).toISOString() }
    const first = await call("POST", "/api/sessions/start", { token: state.token, body, headers: { "Idempotency-Key": key } })
    expectStatus(first, 200, "session start")
    const id = first.body?.session?.id
    expect(Number.isInteger(id), "session start returned no id")
    const replay = await call("POST", "/api/sessions/start", { token: state.token, body, headers: { "Idempotency-Key": key } })
    expectStatus(replay, 200, "session start replay")
    expect(replay.body?.session?.id === id, `replay created a second session (${replay.body?.session?.id} vs ${id})`)
    state.sessionId = id
  }],
  ["POST /api/sessions/:id/set records a set, once per Idempotency-Key", async () => {
    const key = randomUUID()
    const now = Date.now()
    const body = {
      exerciseName: "Bench Press",
      setIndex: 0,
      startTime: new Date(now - 30000).toISOString(),
      endTime: new Date(now - 5000).toISOString(),
      weight: 60,
      reps: 8,
      primaryMuscles: ["chest"],
      secondaryMuscles: [],
    }
    const path = `/api/sessions/${state.sessionId}/set`
    const first = await call("POST", path, { token: state.token, body, headers: { "Idempotency-Key": key } })
    expectStatus(first, 200, "record set")
    const replay = await call("POST", path, { token: state.token, body, headers: { "Idempotency-Key": key } })
    expectStatus(replay, 200, "record set replay")
    const detail = await call("GET", `/api/sessions/${state.sessionId}`, { token: state.token })
    expectStatus(detail, 200, "session detail")
    const sets = detail.body?.session?.setTimings
    expect(Array.isArray(sets), "session detail has no setTimings array")
    expect(sets.length === 1, `expected 1 recorded set after a replay, found ${sets.length}`)
  }],
  ["POST /api/sessions/:id/end ends the workout; a second end is a no-op", async () => {
    const path = `/api/sessions/${state.sessionId}/end`
    const first = await call("POST", path, { token: state.token, body: {} })
    expectStatus(first, 200, "end session")
    expect(first.body?.alreadyEnded === false, "first end reported alreadyEnded")
    const again = await call("POST", path, { token: state.token, body: {} })
    expectStatus(again, 200, "second end")
    expect(again.body?.alreadyEnded === true, "second end did not report alreadyEnded")
  }],
  ["GET /api/sessions lists the workout", async () => {
    const r = await call("GET", "/api/sessions", { token: state.token })
    expectStatus(r, 200, "session history")
    expect(JSON.stringify(r.body).includes(`"id":${state.sessionId}`), "ended session missing from history")
  }],
  ["GET /api/analytics answers", async () => {
    expectStatus(await call("GET", "/api/analytics", { token: state.token }), 200, "analytics")
  }],
  ["GET /api/friends answers", async () => {
    expectStatus(await call("GET", "/api/friends", { token: state.token }), 200, "friends")
  }],
  ["WebSocket /ws authenticates with an auth frame", async () => {
    const reply = await wsAuth(state.token)
    expect(reply.type === "auth_success", `WS replied ${JSON.stringify(reply).slice(0, 200)}`)
    expect(reply.userId === state.uuid, "WS auth_success carries the wrong user")
  }],
  ["WebSocket /ws refuses a bad token", async () => {
    try {
      const reply = await wsAuth("not-a-token")
      expect(reply.type !== "auth_success", "WS accepted a garbage token")
    } catch (err) {
      if (!(err instanceof CheckError) || !/4001/.test(err.message)) throw err
    }
  }],
  ["GET /api/auth/account/export returns the user's data", async () => {
    const r = await call("GET", "/api/auth/account/export", { token: state.token })
    expectStatus(r, 200, "export")
    expect(r.body?.data, "export returned no data")
  }],
]

async function cleanup() {
  if (!state.token) return
  const r = await call("DELETE", "/api/auth/account", { token: state.token, body: { password } })
  if (r.status === 200) pass("DELETE /api/auth/account removes the smoke account")
  else {
    fail(`DELETE /api/auth/account: expected 200, got ${r.status} — remove "${username}" by hand`)
    return false
  }
  const after = await call("POST", "/api/auth/signin", { body: { username, password } })
  if (after.status === 401) pass("deleted account can no longer sign in")
  else {
    fail(`deleted account signin: expected 401, got ${after.status}`)
    return false
  }
  return true
}

console.log(`Smoke test against ${base}`)
let failed = false
try {
  for (const [name, run] of steps) {
    try {
      await run()
      pass(name)
    } catch (err) {
      fail(`${name}\n      ${err instanceof CheckError ? err.message : err.stack || err}`)
      failed = true
      break
    }
  }
} finally {
  if ((await cleanup().catch((err) => (fail(`cleanup: ${err.message}`), false))) === false) failed = true
}

console.log(failed ? paint(31, "Smoke test FAILED") : paint(32, "Smoke test passed"))
process.exit(failed ? 1 : 0)
