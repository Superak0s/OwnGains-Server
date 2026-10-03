// k6 load test simulating lifters using every feature: account, settings, program,
// workouts, analytics, friends, sharing, tracking and a WebSocket.
//   k6 run -e BASE=http://localhost:5000 -e USERS=50 scripts/loadtest.k6.js
// Point it at a throwaway instance. Raise API_RATE_LIMIT / SIGNUP_RATE_LIMIT /
// WS_MAX_CONNECTIONS_PER_IP (or set RATE_LIMIT_BYPASS_LOCAL_IPS=true) on the
// target first, since every VU shares one IP. Creates `k6_*` accounts; teardown deletes them.
// Per-feature timings show up as `group_duration{group:::<name>}` in the summary.
// Not covered: trainer mode, joint-session invite/accept (needs two live sessions
// at once), photo upload, admin and metrics routes.
import http from "k6/http"
import ws from "k6/ws"
import { check, group, sleep } from "k6"
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js"

const BASE = __ENV.BASE || "http://localhost:5000"
const USERS = Number(__ENV.USERS || 50)
const json = { "Content-Type": "application/json" }

// PACE scales every think-time: 1 = real lifters, 0.05 = ~20x the request rate per
// VU. All USERS VUs start at once and run for DURATION (default 5m), then the run
// reports whether p95 < 500ms, p99 < 1s and errors < 1% held; it never aborts early.
const PACE = Number(__ENV.PACE || 1)
const think = (s) => sleep(s * PACE)

// 410 is a server that keeps tracking/supplements on-device (LOCAL_ONLY_FEATURES);
// that refusal is the correct answer there, not a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 410))

export const options = {
  scenarios: {
    lifters: { executor: "constant-vus", vus: USERS, duration: __ENV.DURATION || "5m" },
  },
  setupTimeout: "10m",
  teardownTimeout: "10m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500", "p(99)<1000"],
  },
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
  return users.map(({ username, password, token, uuid, friend }) => ({ username, password, token, uuid, friend }))
}

// Remove the throwaway accounts so a run leaves nothing behind.
export function teardown(users) {
  batched(
    users.map((u) => ({
      method: "DELETE",
      url: `${BASE}/api/auth/account`,
      body: JSON.stringify({ password: u.password }),
      params: { headers: authOf(u) },
    })),
  )
}

export default function (users) {
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
