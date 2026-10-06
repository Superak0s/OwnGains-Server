// k6 load test for OwnGains-Server. Two modes:
//
//   lifter (default): each VU is one person with the app open, doing what the app
//   really does: the launch fetches, a WebSocket held for the whole visit, a
//   ~45 min workout of 12 to 20 sets, a token refresh when the access token nears
//   expiry, and about 1 in 10 visits spent spectating a friend instead (the app
//   polls the live view every 10s). VUs ramp up in STEPS plateaus to USERS and
//   the run aborts at the first plateau where p95/p99/errors break. The last
//   plateau that held is the max concurrent users.
//     k6 run -e BASE=http://localhost:5000 -e USERS=500 scripts/loadtest.k6.js
//   Then report requests per second at that level with one flat run:
//     k6 run -e USERS=<max> -e STEPS=1 -e STEP=10m scripts/loadtest.k6.js
//   Or skip the ramp: all USERS from the first second, for DURATION:
//     k6 run -e USERS=5000 -e DURATION=5m scripts/loadtest.k6.js
//
//   coverage: every VU hits every feature each loop (account, program, social,
//   tracking, supplements, workout, WS). A route regression test, not a capacity
//   model: no real user touches all of it every few minutes.
//     k6 run -e MODE=coverage -e USERS=50 scripts/loadtest.k6.js
//
// Point it at a throwaway instance with the same LOCAL_ONLY_FEATURES as the one
// you are sizing (lifters skip local-only features like the app does). Raise
// API_RATE_LIMIT / SIGNUP_RATE_LIMIT / WS_MAX_CONNECTIONS_PER_IP (or set
// RATE_LIMIT_BYPASS_LOCAL_IPS=true) on the target first, since every VU shares one IP. Creates `k6_*` accounts, teardown signs them in again and deletes them.
// Not covered: trainer mode, joint sessions, photo upload, admin and metrics routes.
import http from "k6/http"
import ws from "k6/ws"
import { WebSocket } from "k6/websockets"
import { setTimeout } from "k6/timers"
import { check, group, sleep } from "k6"
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js"

const BASE = __ENV.BASE || "http://localhost:5000"
const USERS = Number(__ENV.USERS || 50)
const MODE = __ENV.MODE || "lifter"
const json = { "Content-Type": "application/json" }

// PACE scales every wait: 1 = real time, 0.05 = ~20x the request rate per VU
// (a quick smoke run, not a capacity number).
const PACE = Number(__ENV.PACE || 1)
const think = (s) => sleep(s * PACE)

// 410 is a server that keeps tracking/supplements on-device (LOCAL_ONLY_FEATURES);
// that refusal is the correct answer there, not a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 410))

// STEPS plateaus of STEP each (1 min ramp before each), evenly up to USERS.
const STEPS = Number(__ENV.STEPS || 5)
const plateaus = Array.from({ length: STEPS }, (_, i) => Math.ceil((USERS * (i + 1)) / STEPS))
const abort = (threshold) => ({ threshold, abortOnFail: true, delayAbortEval: "1m" })

// DURATION in lifter mode skips the ramp: all USERS start at once, hold for
// DURATION, and the run reports pass/fail at the end instead of aborting.
const RAMP = MODE !== "coverage" && !__ENV.DURATION

export const options = {
  scenarios: RAMP
    ? {
        lifters: {
          executor: "ramping-vus",
          exec: "lifter",
          stages: plateaus.flatMap((target) => [
            { target, duration: "1m" },
            { target, duration: __ENV.STEP || "5m" },
          ]),
        },
      }
    : { [MODE]: { executor: "constant-vus", exec: MODE, vus: USERS, duration: __ENV.DURATION || "5m" } },
  setupTimeout: "30m",
  teardownTimeout: "30m",
  thresholds: RAMP
    ? { http_req_failed: [abort("rate<0.01")], http_req_duration: [abort("p(95)<500"), abort("p(99)<1000")] }
    : { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<500", "p(99)<1000"] },
}

const PROGRAM = {
  originalFilename: "k6.json",
  weeklyPlan: {
    split: ["push"],
    days: [
      {
        dayNumber: 1,
        dayTitle: "Push Day",
        primaryMuscles: ["chest"],
        secondaryMuscles: [],
        split: {
          push: {
            exercises: [
              { name: "Bench Press", sets: 3, reps: "8", primaryMuscles: ["chest"], secondaryMuscles: [] },
            ],
          },
        },
      },
    ],
  },
}

const authOf = (u) => ({ ...json, Authorization: `Bearer ${u.token}` })
const post = (url, body, token) => ({
  method: "POST",
  url: `${BASE}${url}`,
  body: JSON.stringify(body),
  params: { headers: token ? { ...json, Authorization: `Bearer ${token}` } : json, tags: { name: url.replace(/\/\d+\//, "/:id/") } },
})

// Setup and teardown fire hundreds of requests; 20 at a time keeps them inside k6's
// setup limit (serial signups at ~300 ms each blew the default 60 s).
function batched(reqs) {
  const out = []
  for (let i = 0; i < reqs.length; i += 20) out.push(...http.batch(reqs.slice(i, i + 20)))
  return out
}

// Sign up once (real users sign in rarely and bcrypt would dominate), then pair the
// accounts as friends with history + watch grants, and give each a program.
export function setup() {
  const run = uuidv4().slice(0, 8)
  const users = Array.from({ length: USERS }, (_, j) => ({
    username: `k6_${run}_${j}`,
    password: `K6-${uuidv4()}-1`,
  }))
  batched(
    users.map((u) =>
      post("/api/auth/signup", {
        username: u.username,
        email: `${u.username}@example.com`,
        password: u.password,
        name: "k6",
        termsVersion: "k6",
        healthConsent: true,
      }),
    ),
  ).forEach((r, k) => {
    if (r.status !== 201) throw new Error(`signup ${r.status} ${r.body}`)
    users[k].token = r.json("token")
    users[k].refreshToken = r.json("refreshToken")
    users[k].uuid = r.json("user.id")
  })

  // Pairs (0,1), (2,3)...; an odd last user simply has no friend.
  const pairs = users.filter((_, k) => k % 2 === 0 && users[k + 1])
  const sent = batched(pairs.map((u, k) => post("/api/friends/request", { username: users[k * 2 + 1].username }, u.token)))
  sent.forEach((r, k) => {
    if (r.status !== 201) throw new Error(`friend request ${r.status} ${r.body}`)
    pairs[k].requestId = r.json("friendshipId")
  })
  batched(pairs.map((u, k) => post(`/api/friends/request/${u.requestId}/accept`, {}, users[k * 2 + 1].token))).forEach((r) => {
    if (r.status !== 200) throw new Error(`friend accept ${r.status} ${r.body}`)
  })
  const grants = []
  pairs.forEach((a, k) => {
    const b = users[k * 2 + 1]
    a.friend = b.uuid
    b.friend = a.uuid
    for (const [from, to] of [[a, b], [b, a]])
      for (const permissionType of ["history", "watch_session"])
        grants.push(post("/api/sharing/permissions", { friendId: to.uuid, permissionType }, from.token))
  })
  batched(grants).forEach((r) => {
    if (r.status !== 201) throw new Error(`grant ${r.status} ${r.body}`)
  })
  batched(users.map((u) => post("/api/program/upload", PROGRAM, u.token))).forEach((r) => {
    if (r.status !== 200) throw new Error(`program upload ${r.status} ${r.body}`)
  })
  if (RAMP)
    console.log(`plateaus: ${plateaus.map((n, i) => `step ${i + 1} = ${n} users`).join(", ")} (${__ENV.STEP || "5m"} each)`)
  return users.map(({ username, password, token, refreshToken, uuid, friend }) => ({ username, password, token, refreshToken, uuid, friend }))
}

// Remove the throwaway accounts so a run leaves nothing behind. The setup tokens
// have expired by now (and lifters rotated the refresh tokens), so sign in again.
export function teardown(users) {
  const signins = batched(users.map((u) => post("/api/auth/signin", { username: u.username, password: u.password })))
  batched(
    users.map((u, k) => ({
      method: "DELETE",
      url: `${BASE}/api/auth/account`,
      body: JSON.stringify({ password: u.password }),
      params: { headers: { ...json, Authorization: `Bearer ${signins[k].json("token")}` } },
    })),
  )
}

export function coverage(users) {
  const u = users[(__VU - 1) % users.length]
  const auth = authOf(u)
  const h = { headers: auth }
  const idem = () => ({ headers: { ...auth, "Idempotency-Key": uuidv4() } })
  // Ids in a URL would each become their own metric series; group them under one name.
  const named = (name, p = h) => ({ ...p, tags: { name } })
  const now = () => new Date().toISOString()
  const body = (o) => JSON.stringify(o)

  group("account", () => {
    http.get(`${BASE}/api/auth/me`, h)
    http.get(`${BASE}/api/version`, h)
    http.get(`${BASE}/api/settings`, h)
    http.patch(`${BASE}/api/settings`, body({ hydrationGoalMl: 2500 }), h)
    http.put(`${BASE}/api/auth/profile`, body({ name: "k6" }), h)
    // Rare and heavy: bcrypt sign-in and the full data export.
    if (Math.random() < 0.05) http.post(`${BASE}/api/auth/signin`, body({ username: u.username, password: u.password }), { headers: json })
    if (Math.random() < 0.05) http.get(`${BASE}/api/auth/account/export`, h)
  })

  group("program", () => {
    http.get(`${BASE}/api/program`, h)
    http.get(`${BASE}/api/program/current-day`, h)
    http.put(`${BASE}/api/program/current-day`, body({ currentDay: 1 }), h)
    const sets = { dayNumber: 1, split: "push", exerciseIndex: 0 }
    http.patch(`${BASE}/api/program/exercise/sets`, body({ ...sets, additionalSets: 1 }), h)
    http.patch(`${BASE}/api/program/exercise/sets`, body({ ...sets, additionalSets: -1 }), h)
  })

  group("social", () => {
    http.get(`${BASE}/api/friends?include=requests`, h)
    http.get(`${BASE}/api/friends/search?q=k6_`, h)
    http.get(`${BASE}/api/friends/blocked`, h)
    http.get(`${BASE}/api/sharing/permissions/granted`, h)
    http.get(`${BASE}/api/sharing/permissions/received`, h)
    if (u.friend) {
      http.get(`${BASE}/api/sharing/sessions/friend/${u.friend}`, named("friend history"))
      http.get(`${BASE}/api/sharing/joint-sessions/status?friendIds=${u.friend}`, named("joint status batch"))
      http.get(`${BASE}/api/sharing/joint-sessions/friend/${u.friend}/status`, named("joint friend status"))
      // 404 is the right answer while the friend isn't mid-workout.
      http.get(`${BASE}/api/sharing/watch/friend/${u.friend}/active`, {
        ...named("watch active"),
        responseCallback: http.expectedStatuses(200, 404),
      })
    }
  })

  group("tracking", () => {
    http.post(`${BASE}/api/tracking/bodystats/weight`, body({ weightKg: 80 }), h)
    http.get(`${BASE}/api/tracking/bodystats/weight`, h)
    http.post(`${BASE}/api/tracking/hydration`, body({ amountMl: 250 }), idem())
    http.get(`${BASE}/api/tracking/hydration`, h)
    http.get(`${BASE}/api/tracking/measurements/definitions`, h)
    http.get(`${BASE}/api/tracking/measurements?metrics=waist_cm`, h)
    http.post(`${BASE}/api/tracking/soreness`, body({ muscleGroup: "chest", intensity: 3 }), idem())
    http.get(`${BASE}/api/tracking/soreness`, h)
    http.post(`${BASE}/api/tracking/injuries`, body({ muscleGroup: "chest", injuryType: "strain", painLevel: 3 }), idem())
    http.get(`${BASE}/api/tracking/injuries`, h)
    http.post(`${BASE}/api/tracking/macros/log`, body({ name: "k6", protein: 30, carbs: 50, fat: 10, calories: 400, takenAt: now() }), idem())
    http.get(`${BASE}/api/tracking/macros/log`, h)
    http.post(`${BASE}/api/tracking/personal-notes`, body({ muscleGroup: "chest", content: "k6 note" }), idem())
    http.get(`${BASE}/api/tracking/personal-notes/muscle/chest`, h)
    http.post(`${BASE}/api/tracking/menstrual`, body({ cycleStart: now() }), idem())
    http.get(`${BASE}/api/tracking/menstrual`, h)
    http.get(`${BASE}/api/tracking/photos/muscle`, h)
  })

  group("supplements", () => {
    const created = http.post(`${BASE}/api/tracking/supplements`, body({ name: `k6 ${uuidv4().slice(0, 6)}`, unit: "g", defaultAmount: 5 }), h)
    if (created.status === 201) {
      const id = created.json("data.id")
      http.post(`${BASE}/api/tracking/supplements/${id}/log`, body({ amount: 5 }), named("supplement log", idem()))
      http.get(`${BASE}/api/tracking/supplements/${id}/log`, named("supplement log list"))
      // Delete again so repeated iterations don't hit the per-user supplement cap.
      http.del(`${BASE}/api/tracking/supplements/${id}`, null, named("supplement delete"))
    }
    http.get(`${BASE}/api/tracking/supplements`, h)
  })

  group("workout", () => {
    http.get(`${BASE}/api/sessions`, h)
    http.get(`${BASE}/api/sessions/exercise-records`, h)
    const start = http.post(
      `${BASE}/api/sessions/start`,
      body({ dayNumber: 1, dayTitle: "Push Day", split: "push", startTime: now() }),
      idem(),
    )
    if (!check(start, { "start 200": (r) => r.status === 200 })) return
    const id = start.json("session.id")
    for (let i = 0; i < 3; i++) {
      think(30 + Math.random() * 60) // rest between sets
      const t = Date.now()
      http.post(
        `${BASE}/api/sessions/${id}/set`,
        body({
          exerciseName: "Bench Press",
          setIndex: i,
          startTime: new Date(t - 30000).toISOString(),
          endTime: new Date(t).toISOString(),
          weight: 60,
          reps: 8,
          primaryMuscles: ["chest"],
          secondaryMuscles: [],
        }),
        named("session set", idem()),
      )
    }
    http.get(`${BASE}/api/sessions/${id}`, named("session get"))
    http.post(`${BASE}/api/sessions/${id}/end`, "{}", named("session end", idem()))
    http.get(`${BASE}/api/analytics`, h)
  })

  // Live feed: connect, authenticate in-band (never in the URL), hold briefly, leave.
  if (Math.random() < 0.3) {
    ws.connect(`${BASE.replace(/^http/, "ws")}/ws`, {}, (socket) => {
      socket.on("open", () => socket.send(body({ type: "auth", token: u.token })))
      socket.setTimeout(() => socket.close(), 3000)
    })
  }
  think(60)
}

// ---- lifter mode ----

const pause = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000 * PACE))
const between = (lo, hi) => lo + Math.random() * (hi - lo)
// Refresh a minute before the access token expires (JWT_EXPIRES_IN on the target).
const TOKEN_TTL_MS = Number(__ENV.TOKEN_TTL_MIN || 15) * 60e3
const EXERCISES = ["Bench Press", "Incline Dumbbell Press", "Overhead Press", "Lateral Raise", "Triceps Pushdown"]

// Refresh tokens rotate on every use, so each VU owns one account and keeps its
// tokens here across iterations instead of reusing setup()'s copy.
let me = null

function refresh() {
  const r = http.post(`${BASE}/api/auth/refresh`, JSON.stringify({ refreshToken: me.refreshToken }), {
    headers: json,
    tags: { name: "/api/auth/refresh" },
  })
  if (r.status === 200) {
    me.token = r.json("token")
    me.refreshToken = r.json("refreshToken")
  } else {
    // A dead refresh token logs the user out: they sign in again.
    const s = http.post(`${BASE}/api/auth/signin`, JSON.stringify({ username: me.username, password: me.password }), {
      headers: json,
      tags: { name: "/api/auth/signin" },
    })
    me.token = s.json("token")
    me.refreshToken = s.json("refreshToken")
  }
  me.refreshAt = Date.now() + TOKEN_TTL_MS - 60e3
}

export async function lifter(users) {
  me ??= { ...users[__VU - 1] }
  let sock = null
  const fresh = () => {
    if (Date.now() < me.refreshAt) return
    refresh()
    if (sock?.readyState === 1) sock.send(JSON.stringify({ type: "auth.refresh", token: me.token }))
  }
  const req = (method, path, body = null, { name = path.split("?")[0], idem = false, ok } = {}) => {
    fresh()
    const headers = { ...json, Authorization: `Bearer ${me.token}` }
    if (idem) headers["Idempotency-Key"] = uuidv4()
    const params = { headers, tags: { name } }
    if (ok) params.responseCallback = http.expectedStatuses(...ok)
    return http.request(method, `${BASE}${path}`, body && JSON.stringify(body), params)
  }
  const get = (path, opts) => req("GET", path, null, opts)

  // App launch: the stored access token is stale, so the first call is a refresh.
  const health = http.get(`${BASE}/healthz`, { tags: { name: "/healthz" } })
  const localOnly = (health.status === 200 && health.json("localOnlyFeatures")) || []
  me.refreshAt = 0
  get("/api/version")
  get("/api/auth/me")
  get("/api/settings")
  get("/api/program")
  get("/api/program/current-day")
  get("/api/sessions?split=push&dayNumber=1&limit=10&includeTimings=false")
  get("/api/sessions/exercise-records")
  get("/api/analytics?split=push&dayNumber=1&days=365")
  get("/api/friends")
  get("/api/friends/requests/pending")
  get("/api/sharing/permissions/received?includePayload=true")
  if (me.friend) get(`/api/sharing/joint-sessions/status?friendIds=${me.friend}`)

  // The app holds one socket for as long as it is in the foreground.
  sock = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`)
  sock.onopen = () => sock.send(JSON.stringify({ type: "auth", token: me.token }))
  sock.onmessage = (e) => {
    const type = JSON.parse(e.data).type
    if (type === "auth_success" || type === "error") check(type, { "ws auth": (t) => t === "auth_success" })
  }
  sock.onerror = () => check(null, { "ws auth": () => false })
  await pause(between(5, 20))

  const spectate = me.friend && Math.random() < 0.1
  const active = spectate && get(`/api/sharing/watch/friend/${me.friend}/active`, { name: "watch active", ok: [200, 404] })
  if (active && active.status === 200) {
    // Watch until the friend finishes or we lose interest, polling like the app.
    const sid = active.json("session.sessionId")
    const until = Date.now() + between(5, 15) * 60e3 * PACE
    while (Date.now() < until) {
      const live = get(`/api/sharing/watch/friend/${me.friend}/session/${sid}/live`, { name: "watch live", ok: [200, 404] })
      if (live.status !== 200) break
      await pause(10)
    }
  } else {
    const start = req("POST", "/api/sessions/start", { dayNumber: 1, dayTitle: "Push Day", split: "push", startTime: new Date().toISOString() }, { idem: true })
    if (check(start, { "start 200": (r) => r.status === 200 })) {
      const id = start.json("session.id")
      let setIndex = 0
      for (const exerciseName of EXERCISES.slice(0, 4 + Math.floor(Math.random() * 2))) {
        const sets = 3 + Math.floor(Math.random() * 2)
        for (let i = 0; i < sets; i++) {
          await pause(between(90, 180)) // rest, or walking to the next machine
          const end = Date.now()
          req(
            "POST",
            `/api/sessions/${id}/set`,
            {
              exerciseName,
              setIndex: setIndex++,
              startTime: new Date(end - between(20, 60) * 1000).toISOString(),
              endTime: new Date(end).toISOString(),
              weight: 60,
              reps: 8,
              primaryMuscles: ["chest"],
              secondaryMuscles: [],
            },
            { name: "session set", idem: true },
          )
        }
      }
      req("POST", `/api/sessions/${id}/end`, {}, { name: "session end", idem: true })
      get("/api/analytics?split=push&dayNumber=1&days=365")
      get("/api/sessions?split=push&dayNumber=1&limit=10&includeTimings=false")
    }
  }

  // Some people log their weight and water once a visit, unless this server
  // keeps tracking on-device (then the app never calls it).
  if (!localOnly.includes("tracking") && Math.random() < 0.3) {
    req("POST", "/api/tracking/bodystats/weight", { weightKg: 80 })
    req("POST", "/api/tracking/hydration", { amountMl: 500 }, { idem: true })
  }

  await pause(between(5, 30))
  sock.close()
}
