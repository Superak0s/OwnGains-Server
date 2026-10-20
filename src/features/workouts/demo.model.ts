import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { formatDateForMySQL, withTransaction } from "@/config/database.js"
import { readLocalOnlyFeatures } from "@/config/env.js"
import { findOrCreateExercise, findProgramDayId } from "./workouts.model.js"

interface DemoExercise {
  name: string
  sets: number
  primaryMuscles?: string[]
  secondaryMuscles?: string[]
}

interface DemoDay {
  dayNumber: number
  dayTitle: string
  exercises: DemoExercise[]
}

interface DemoFillResult {
  sessions: number
  sets: number
  friends: number
  tracking: number
}

const DAY_MS = 86_400_000
const SET_MS = 45_000
const REST_MS = 150_000
const DAYS_BETWEEN_SESSIONS = 2
const DEMO_SESSION_COUNT = 18
const FRIEND_SESSION_COUNT = 12

const FRIEND_DAYS: DemoDay[] = [
  {
    dayNumber: 1,
    dayTitle: "Upper",
    exercises: [
      { name: "Bench Press", sets: 4, primaryMuscles: ["Chest"] },
      { name: "Barbell Row", sets: 4, primaryMuscles: ["Back"] },
      { name: "Overhead Press", sets: 3, primaryMuscles: ["Shoulders"] },
    ],
  },
  {
    dayNumber: 2,
    dayTitle: "Lower",
    exercises: [
      { name: "Back Squat", sets: 4, primaryMuscles: ["Quads"] },
      { name: "Romanian Deadlift", sets: 3, primaryMuscles: ["Hamstrings"] },
      { name: "Standing Calf Raise", sets: 3, primaryMuscles: ["Calves"] },
    ],
  },
]

const ALL_PERMISSIONS = ["history", "analytics", "program", "joint_session", "watch_session", "trainer", "tracking"]

// Named after how much each one shares with the caller.
const FRIENDS = [
  { name: "None", strength: 1, grants: [] },
  { name: "Half", strength: 0.9, grants: ["history", "analytics", "program", "watch_session"] },
  { name: "All", strength: 1.3, grants: ALL_PERMISSIONS },
] as const
type FriendName = (typeof FRIENDS)[number]["name"]

// Sender, recipient ("me" is the caller), minutes ago, text. The caller's
// messages from the last hour stay unread.
const DEMO_MESSAGES: [FriendName | "me", FriendName | "me", number, string][] = [
  ["None", "me", 1500, "Hey! Just joined OwnGains."],
  ["me", "None", 1490, "Welcome! Share your history whenever you like."],
  ["None", "me", 1480, "Will do once I have a few workouts in."],
  ["Half", "me", 2900, "How do you like the new program?"],
  ["me", "Half", 2880, "Loving it, my squat is finally moving."],
  ["Half", "me", 25, "I'll watch your next session, curious how you pace the rests."],
  ["All", "me", 4300, "Nice session yesterday! Thanks for logging it for me."],
  ["me", "All", 4280, "Anytime. I suggested two workouts for next week."],
  ["All", "me", 4270, "Saw them, accepted the first one."],
  ["All", "me", 40, "I suggested a morning workout for you too, have a look."],
  ["None", "Half", 3000, "Are you training tomorrow?"],
  ["Half", "None", 2990, "Yes, lower day at 7."],
  ["Half", "All", 2000, "Can I copy your program?"],
  ["All", "Half", 1990, "Sure, it's shared with you."],
  ["All", "None", 1000, "Welcome to the group!"],
  ["None", "All", 990, "Thanks!"],
]

/** FRIEND_DAYS in the program shape the app uploads and a `program` grant carries. */
const FRIEND_PROGRAM = {
    name: "Upper/Lower Program, 2 Days",
    totalDays: FRIEND_DAYS.length,
    split: ["Me"],
    days: FRIEND_DAYS.map((day) => ({
      dayNumber: day.dayNumber,
      dayTitle: day.dayTitle,
      exercises: day.exercises.map((ex) => ({
        name: ex.name,
        primaryMuscles: ex.primaryMuscles!, // Every friend exercise lists them.
        secondaryMuscles: [],
        setsBySplit: { Me: ex.sets },
        reps: "8-10",
      })),
      split: {
        Me: {
          exercises: day.exercises.map((ex) => ({
            name: ex.name,
            primaryMuscles: ex.primaryMuscles!, // Every friend exercise lists them.
            secondaryMuscles: [],
            sets: ex.sets,
            reps: "8-10",
          })),
          totalSets: day.exercises.reduce((sum, ex) => sum + ex.sets, 0),
        },
      },
    })),
}
const FRIEND_PROGRAM_PAYLOAD = JSON.stringify({ programData: FRIEND_PROGRAM, message: null })

/** Deterministic, so a refill produces the same numbers rather than noise. */
const baseWeight = (name: string): number => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 997
  return 20 + (hash % 9) * 5
}

const toPlate = (kg: number): number => Math.round(kg / 2.5) * 2.5

/**
 * Finished workouts spread backwards over ~5 weeks, one every other day,
 * cycling through `days` with a small weekly weight progression. Each workout
 * is two statements: the workout row and one multi-row insert of its sets.
 */
async function insertWorkouts(
  conn: PoolConnection,
  userId: number,
  days: DemoDay[],
  split: string | null,
  count: number,
  opts: { isDemo: boolean; strength: number; linkProgram: boolean; now: number; loggedBy?: number },
): Promise<{ sessions: number; sets: number }> {
  const exerciseIds = new Map<string, number>()
  for (const day of days)
    for (const ex of day.exercises)
      if (!exerciseIds.has(ex.name))
        exerciseIds.set(
          ex.name,
          await findOrCreateExercise(userId, ex.name, ex.primaryMuscles, ex.secondaryMuscles, conn),
        )

  const programDayIds = new Map<number, number | null>()
  if (opts.linkProgram)
    for (const day of days)
      programDayIds.set(day.dayNumber, await findProgramDayId(userId, day.dayNumber))

  let totalSets = 0
  for (let i = 0; i < count; i++) {
    const day = days[i % days.length]
    const week = Math.floor((i * DAYS_BETWEEN_SESSIONS) / 7)
    const start = opts.now - (count - i) * DAYS_BETWEEN_SESSIONS * DAY_MS
    const { sets, end } = demoSetRows(day, start, exerciseIds, opts.strength * (1 + 0.03 * week))
    if (sets.length === 0) continue

    const [workout] = await conn.execute<ResultSetHeader>(
      `INSERT INTO workouts (user_id, program_day_id, day_number, day_title, split,
         start_time, end_time, total_duration, completed_sets, is_demo, logged_by_trainer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        programDayIds.get(day.dayNumber) ?? null,
        day.dayNumber,
        day.dayTitle,
        split,
        formatDateForMySQL(new Date(start)),
        formatDateForMySQL(new Date(end)),
        Math.round((end - start) / 1000),
        sets.length,
        opts.isDemo ? 1 : 0,
        // Every other one, so the client's history mixes trainer-run and own workouts.
        opts.loggedBy && i % 2 ? opts.loggedBy : null,
      ],
    )
    await conn.execute(
      `INSERT INTO workout_sets (workout_id, exercise_id, set_index, start_time, end_time,
         set_duration, rest_time, weight, reps)
       VALUES ${sets.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      sets.flatMap((row) => [workout.insertId, ...row]),
    )
    totalSets += sets.length
  }
  return { sessions: count, sets: totalSets }
}

/**
 * An open workout two sets in, the last ending a minute before `now`, so the
 * friend shows as mid-workout to watchers and trainers. sessionCleanup ends it
 * after 30 idle minutes.
 */
async function insertLiveWorkout(
  conn: PoolConnection,
  userId: number,
  strength: number,
  now: number,
): Promise<void> {
  const day = FRIEND_DAYS[0]
  const ex = { ...day.exercises[0], sets: 2 }
  const exerciseId = await findOrCreateExercise(userId, ex.name, ex.primaryMuscles, ex.secondaryMuscles, conn)
  const start = now - 2 * SET_MS - REST_MS - 60_000
  const { sets } = demoSetRows({ ...day, exercises: [ex] }, start, new Map([[ex.name, exerciseId]]), strength * 1.1)
  const [workout] = await conn.execute<ResultSetHeader>(
    `INSERT INTO workouts (user_id, day_number, day_title, split, start_time, completed_sets, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [userId, day.dayNumber, day.dayTitle, "Upper/Lower", formatDateForMySQL(new Date(start)), sets.length],
  )
  await conn.execute(
    `INSERT INTO workout_sets (workout_id, exercise_id, set_index, start_time, end_time,
       set_duration, rest_time, weight, reps)
     VALUES ${sets.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
    sets.flatMap((row) => [workout.insertId, ...row]),
  )
}

/** One workout's set rows, back to back from `start`, and when the last ends. */
function demoSetRows(
  day: DemoDay,
  start: number,
  exerciseIds: Map<string, number>,
  load: number,
): { sets: (string | number | null)[][]; end: number } {
  let cursor = start
  let prevEnd: number | null = null
  const sets: (string | number | null)[][] = []
  for (const ex of day.exercises) {
    for (let setIndex = 1; setIndex <= ex.sets; setIndex++) {
      const end = cursor + SET_MS
      sets.push([
        exerciseIds.get(ex.name)!,
        setIndex,
        formatDateForMySQL(new Date(cursor)),
        formatDateForMySQL(new Date(end)),
        SET_MS / 1000,
        prevEnd === null ? null : Math.round((cursor - prevEnd) / 1000),
        toPlate(baseWeight(ex.name) * load),
        Math.max(6, 11 - setIndex),
      ])
      prevEnd = end
      cursor = end + REST_MS
    }
  }
  return { sets, end: prevEnd ?? start }
}

/**
 * Suspended from creation, so they can never sign in or show up in search,
 * and cascade-deleted with their owner. Consented, since no person stands
 * behind them and their owner logs workouts for them in trainer mode.
 */
async function createDemoUser(
  conn: PoolConnection,
  ownerId: number,
  name: string,
): Promise<number> {
  const uuid = randomUUID()
  const [result] = await conn.execute<ResultSetHeader>(
    `INSERT INTO users (uuid, username, email, password_hash, name,
       disabled_at, disabled_reason, demo_owner_id, health_consent_at)
     VALUES (?, ?, ?, '!', ?, NOW(), 'Demo account', ?, NOW())`,
    [uuid, `demo_${name.toLowerCase()}_${randomBytes(3).toString("hex")}`, `${uuid}@demo.invalid`, name, ownerId],
  )
  return result.insertId
}

const SCHEDULE_TABLE = "scheduled_workouts"

const DEMO_TABLES = [
  "measurements",
  "macros_intake",
  "soreness",
  "injuries",
  "menstrual_cycle",
  "muscle_notes",
  "supplements",
  "progress_photos",
] as const
type DemoTable = (typeof DEMO_TABLES)[number]
type Row = (string | number | null)[]

// Black placeholders naming the muscle, one font per photo so they tell apart
// when compared. They are small enough to be their own thumbnail.
const DEMO_PHOTO_MUSCLES = [
  ["chest_upper", "front"],
  ["lats", "back"],
  ["shoulders_side", "side"],
  ["biceps", "front"],
  ["triceps", "back"],
  ["abs_upper", "front"],
  ["quads", "front"],
  ["hamstrings", "back"],
  ["glutes", "back"],
  ["calves", "side"],
] as const
const DEMO_PHOTO_DAYS_AGO = [28, 14, 0]

/** Multi-row insert whose new ids are recorded in demo_rows for removal. */
async function insertDemoRows(
  conn: PoolConnection,
  userId: number,
  table: DemoTable | typeof SCHEDULE_TABLE,
  columns: string[],
  rows: Row[],
): Promise<number> {
  const placeholders = `(${["?", ...columns.map(() => "?")].join(", ")})`
  const [result] = await conn.execute<ResultSetHeader>(
    `INSERT INTO ${table} (user_id, ${columns.join(", ")})
     VALUES ${rows.map(() => placeholders).join(", ")}`,
    rows.flatMap((row) => [userId, ...row]),
  )
  await conn.execute(
    `INSERT INTO demo_rows (user_id, table_name, row_id)
     SELECT user_id, ?, id FROM ${table} WHERE user_id = ? AND id BETWEEN ? AND ?`,
    [table, userId, result.insertId, result.insertId + result.affectedRows - 1],
  )
  return result.affectedRows
}

/**
 * About five weeks of tracking and supplement entries, for the features this
 * server stores. Local-only ones are seeded on the device instead.
 */
async function insertTracking(conn: PoolConnection, userId: number, now: number): Promise<number> {
  const localOnly = readLocalOnlyFeatures()
  const at = (daysAgo: number, hour = 9) => {
    const d = new Date(now - daysAgo * DAY_MS)
    d.setUTCHours(hour, 0, 0, 0)
    return formatDateForMySQL(d)
  }
  let count = 0

  if (!localOnly.includes("tracking")) {
    count += await insertTrackingDemo(conn, userId, at)
    count += await insertDemoPhotos(conn, userId, at)
  }
  if (!localOnly.includes("supplements")) count += await insertSupplementsDemo(conn, userId, at)
  return count
}

type DemoAt = (daysAgo: number, hour?: number) => string
const DEMO_TRACKING_DAYS = 35

async function insertTrackingDemo(conn: PoolConnection, userId: number, at: DemoAt): Promise<number> {
  const days = DEMO_TRACKING_DAYS
  let count = 0
  const metrics: Row[] = []
  const macros: Row[] = []
  for (let d = days; d >= 0; d--) {
    const progress = (days - d) / days
    if (d % 2 === 0) metrics.push(["weight_kg", 82 - 2.5 * progress, at(d, 7), 0])
    metrics.push(["water_ml", 500, at(d, 8), 0], ["water_ml", 750 + (d % 3) * 250, at(d, 15), 0])
    if (d % 7 === 0)
      for (const [metric, value] of [
        ["body_fat_pct", 18 - 2 * progress],
        ["waist_cm", 86 - 3 * progress],
        ["neck_cm", 38],
        ["chest_cm", 102 + progress],
        ["arm_left_cm", 36 + progress],
        ["arm_right_cm", 36 + progress],
      ] as const)
        metrics.push([metric, value, at(d), 0])
    macros.push(["Daily intake", 150 + (d % 4) * 10, 230 + (d % 5) * 15, 65 + (d % 3) * 5, 2300 + (d % 5) * 80, at(d, 13)])
  }
  count += await insertDemoRows(conn, userId, "measurements", ["metric", "value", "measured_at", "entry_seq"], metrics)
  count += await insertDemoRows(conn, userId, "macros_intake", ["name", "protein", "carbs", "fat", "calories", "taken_at"], macros)
  count += await insertDemoRows(conn, userId, "soreness", ["muscle_group", "intensity", "logged_at"], [
    ["quads", 6, at(1, 18)],
    ["chest_upper", 4, at(2, 18)],
  ])
  count += await insertDemoRows(conn, userId, "injuries", ["muscle_group", "injury_type", "pain_level", "start_date", "note"], [
    ["lower_back", "strain", 3, at(10), "Demo injury"],
  ])
  count += await insertDemoRows(conn, userId, "muscle_notes", ["muscle_group", "content"], [
    ["shoulders_front", "Warm up with band pull-aparts."],
  ])
  count += await insertDemoRows(conn, userId, "menstrual_cycle", ["cycle_start", "symptoms"], [
    [at(56), '["cramps"]'],
    [at(28), '["cramps"]'],
    [at(0), '["cramps"]'],
  ])

  const [height] = await conn.execute<ResultSetHeader>(
    `UPDATE users SET height_cm = 178 WHERE id = ? AND height_cm IS NULL`,
    [userId],
  )
  if (height.affectedRows)
    await conn.execute(
      `INSERT INTO demo_rows (user_id, table_name, row_id) VALUES (?, 'users', ?)`,
      [userId, userId],
    )
  return count
}

async function insertDemoPhotos(conn: PoolConnection, userId: number, at: DemoAt): Promise<number> {
  let count = 0
  for (const [muscle, angle] of DEMO_PHOTO_MUSCLES)
    for (const [i, daysAgo] of DEMO_PHOTO_DAYS_AGO.entries()) {
      const data = await readFile(new URL(`./demo-photos/${muscle}-${i + 1}.jpg`, import.meta.url))
      count += await insertDemoRows(conn, userId, "progress_photos", ["mime_type", "file_size", "content_hash", "taken_at", "note", "angle"], [
        ["image/jpeg", data.length, createHash("sha256").update(data).digest("hex"), at(daysAgo, 8), "Demo photo", angle],
      ])
      const [[{ id }]] = await conn.query<(RowDataPacket & { id: number })[]>(
        `SELECT MAX(row_id) AS id FROM demo_rows WHERE user_id = ? AND table_name = 'progress_photos'`,
        [userId],
      )
      await conn.execute(`INSERT INTO progress_photo_blobs (photo_id, data) VALUES (?, ?)`, [id, data])
      await conn.execute(`INSERT INTO progress_photo_thumbs (photo_id, data) VALUES (?, ?)`, [id, data])
      await conn.execute(`INSERT INTO progress_photo_muscles (photo_id, muscle_group) VALUES (?, ?)`, [id, muscle])
    }
  return count
}

async function insertSupplementsDemo(conn: PoolConnection, userId: number, at: DemoAt): Promise<number> {
  const days = DEMO_TRACKING_DAYS
  let count = 0
  const supplements = [
    { name: "Creatine (demo)", unit: "g", amount: 5 },
    { name: "Vitamin D (demo)", unit: "IU", amount: 2000 },
    { name: "Omega-3 (demo)", unit: "caps", amount: 2 },
  ]
  for (const [i, sup] of supplements.entries()) {
    count += await insertDemoRows(conn, userId, "supplements", ["name", "unit", "default_amount"], [
      [sup.name, sup.unit, sup.amount],
    ])
    const [[{ id }]] = await conn.query<(RowDataPacket & { id: number })[]>(
      `SELECT MAX(row_id) AS id FROM demo_rows WHERE user_id = ? AND table_name = 'supplements'`,
      [userId],
    )
    const doses: Row[] = []
    for (let d = days; d >= 0; d--)
      if ((d + i) % 5 !== 0) doses.push([userId, id, sup.amount, at(d, 8 + i)])
    await conn.execute(
      `INSERT INTO supplement_intake (user_id, supplement_id, amount, taken_at)
       VALUES ${doses.map(() => "(?, ?, ?, ?)").join(", ")}`,
      doses.flat(),
    )
  }
  return count
}

async function deleteDemoData(conn: PoolConnection, userId: number) {
  await conn.execute(
    // Only while it still holds the demo's 178: a height the user entered
    // after the fill is theirs.
    `UPDATE users SET height_cm = NULL WHERE id = ? AND height_cm = 178 AND EXISTS
       (SELECT 1 FROM demo_rows WHERE user_id = ? AND table_name = 'users')`,
    [userId, userId],
  )
  let tracking = 0
  for (const table of DEMO_TABLES) {
    const [rows] = await conn.execute<ResultSetHeader>(
      `DELETE t FROM ${table} t
       JOIN demo_rows d ON d.user_id = t.user_id AND d.table_name = ? AND d.row_id = t.id
       WHERE t.user_id = ?`,
      [table, userId],
    )
    tracking += rows.affectedRows
  }
  await conn.execute(
    `DELETE t FROM ${SCHEDULE_TABLE} t
     JOIN demo_rows d ON d.user_id = t.user_id AND d.table_name = ? AND d.row_id = t.id
     WHERE t.user_id = ?`,
    [SCHEDULE_TABLE, userId],
  )
  await conn.execute(`DELETE FROM demo_rows WHERE user_id = ?`, [userId])
  const [workouts] = await conn.execute<ResultSetHeader>(
    `DELETE FROM workouts WHERE user_id = ? AND is_demo = 1`,
    [userId],
  )
  const [friends] = await conn.execute<ResultSetHeader>(
    `DELETE FROM users WHERE demo_owner_id = ?`,
    [userId],
  )
  return { sessions: workouts.affectedRows, friends: friends.affectedRows, tracking }
}

/**
 * Replaces the caller's demo data in one transaction: their own demo workouts
 * for `days`, three demo friends sharing nothing, half or everything (the last
 * two mid-workout), messages among all four, scheduled workouts and trainer
 * suggestions both ways, a received and a sent trainer request, and
 * tracking/supplement entries. Refilling never stacks a second copy.
 */
export async function fillDemoData(
  userId: number,
  days: DemoDay[],
  split: string | null,
  now = Date.now(),
): Promise<DemoFillResult> {
  return withTransaction(async (conn) => {
    await deleteDemoData(conn, userId)

    const own = await insertWorkouts(conn, userId, days, split, DEMO_SESSION_COUNT, {
      isDemo: true,
      strength: 1,
      linkProgram: true,
      now,
    })

    const friendIds = new Map<FriendName, number>()
    for (const friend of FRIENDS) {
      const friendId = await createDemoUser(conn, userId, friend.name)
      friendIds.set(friend.name, friendId)
      await conn.execute(
        `INSERT INTO friendships (user_id, friend_id, requested_by, status, accepted_at)
         VALUES (LEAST(?, ?), GREATEST(?, ?), ?, 'accepted', ?)`,
        [userId, friendId, userId, friendId, friendId, formatDateForMySQL(new Date(now))],
      )
      if (friend.grants.length > 0)
        await conn.execute(
          `INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type, payload)
           VALUES ${friend.grants.map(() => "(?, ?, ?, ?)").join(", ")}`,
          friend.grants.flatMap((type) => [
            friendId,
            userId,
            type,
            type === "program" ? FRIEND_PROGRAM_PAYLOAD : null,
          ]),
        )
      // is_demo stays 0: friend views hide demo workouts, and these exist only
      // to be seen there.
      await insertWorkouts(conn, friendId, FRIEND_DAYS, "Upper/Lower", FRIEND_SESSION_COUNT, {
        isDemo: false,
        strength: friend.strength,
        linkProgram: false,
        now,
        loggedBy: (friend.grants as readonly string[]).includes("trainer") ? userId : undefined,
      })
      if ((friend.grants as readonly string[]).includes("trainer"))
        await insertFriendProgram(conn, friendId)
      if (friend.grants.some((g) => g === "watch_session" || g === "trainer"))
        await insertLiveWorkout(conn, friendId, friend.strength, now)
    }

    // Coach asks to train the owner, and the owner has asked None.
    const coachId = await createDemoUser(conn, userId, "Coach")
    await conn.execute(
      `INSERT INTO trainer_requests (from_user_id, to_user_id) VALUES (?, ?), (?, ?)`,
      [coachId, userId, userId, friendIds.get("None")!],
    )

    await insertMessages(conn, userId, friendIds, now)
    await insertSchedule(conn, userId, friendIds.get("All")!, days[0]?.dayNumber ?? null, now)

    const tracking = await insertTracking(conn, userId, now)

    return { ...own, friends: FRIENDS.length, tracking }
  })
}

async function insertMessages(
  conn: PoolConnection,
  userId: number,
  friendIds: Map<FriendName, number>,
  now: number,
): Promise<void> {
  const id = (who: FriendName | "me") => (who === "me" ? userId : friendIds.get(who)!)
  await conn.execute(
    `INSERT INTO messages (sender_id, recipient_id, body, created_at, read_at)
     VALUES ${DEMO_MESSAGES.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    DEMO_MESSAGES.flatMap(([from, to, minutesAgo, body]) => {
      const at = formatDateForMySQL(new Date(now - minutesAgo * 60_000))
      return [id(from), id(to), body, at, to === "me" && minutesAgo < 60 ? null : at]
    }),
  )
}

/**
 * Two upcoming workouts of the caller's own, one pending suggestion from All
 * (who the caller makes their trainer for it), and the caller's own pending and
 * accepted suggestions for All, who already has them as trainer.
 */
async function insertSchedule(
  conn: PoolConnection,
  userId: number,
  allId: number,
  programDay: number | null,
  now: number,
): Promise<void> {
  const at = (daysAhead: number, hour: number) => {
    const d = new Date(now + daysAhead * DAY_MS)
    d.setUTCHours(hour, 0, 0, 0)
    return formatDateForMySQL(d)
  }
  await conn.execute(
    `INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type) VALUES (?, ?, 'trainer')`,
    [userId, allId],
  )
  const columns = ["title", "program_day", "start_at", "duration_min", "reminder_minutes", "created_by_trainer_id", "accepted_at"]
  const accepted = formatDateForMySQL(new Date(now))
  await insertDemoRows(conn, userId, SCHEDULE_TABLE, columns, [
    ["Demo workout", programDay, at(1, 16), 60, 30, null, accepted],
    ["Demo workout", programDay, at(3, 16), 60, 30, null, accepted],
    ["Morning session", null, at(2, 6), 45, 15, allId, null],
  ])
  await conn.execute(
    `INSERT INTO ${SCHEDULE_TABLE} (user_id, ${columns.join(", ")})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ...[allId, "Upper", 1, at(2, 17), 60, 30, userId, accepted],
      ...[allId, "Lower", 2, at(4, 17), 60, 30, userId, null],
    ],
  )
}

/**
 * Stores FRIEND_PROGRAM as a demo client's own program, so a trainer's edits
 * have rows to change. Plain inserts on the fill's connection: the user is new,
 * and upsertProgram's own transaction deadlocked against it.
 */
async function insertFriendProgram(conn: PoolConnection, userId: number): Promise<void> {
  const [program] = await conn.execute<ResultSetHeader>(
    `INSERT INTO programs (user_id, original_filename, split_order) VALUES (?, ?, ?)`,
    [userId, "Demo program", JSON.stringify(FRIEND_PROGRAM.split)],
  )
  for (const day of FRIEND_DAYS) {
    const [dayRow] = await conn.execute<ResultSetHeader>(
      `INSERT INTO program_days (program_id, day_number, title, primary_muscles)
       VALUES (?, ?, ?, ?)`,
      [
        program.insertId,
        day.dayNumber,
        day.dayTitle,
        JSON.stringify([...new Set(day.exercises.flatMap((ex) => ex.primaryMuscles ?? []))]),
      ],
    )
    const slots = await Promise.all(
      day.exercises.map(async (ex, position) => [
        dayRow.insertId,
        "Me",
        position,
        await findOrCreateExercise(userId, ex.name, ex.primaryMuscles, ex.secondaryMuscles, conn),
        ex.sets,
        "8-10",
      ]),
    )
    await conn.execute(
      `INSERT INTO program_exercises
         (program_day_id, split_name, position, exercise_id, target_sets, target_reps)
       VALUES ${slots.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      slots.flat(),
    )
  }
}

/**
 * Removes all demo workouts, friends and tracking data of a user.
 *
 * @param userId - Numeric id of the owner.
 * @returns How many workouts, friends and tracking rows were removed.
 */
export async function clearDemoData(
  userId: number,
): Promise<{ sessions: number; friends: number; tracking: number }> {
  return withTransaction((conn) => deleteDemoData(conn, userId))
}
