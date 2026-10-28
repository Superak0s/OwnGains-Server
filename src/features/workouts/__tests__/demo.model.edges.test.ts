// fillDemoData called directly with days the app wouldn't send: an exercise
// repeated across days and a day with none. Also a user who already has a
// height, and a server keeping tracking and supplements on the device.
import { describe, it, expect, afterEach, vi } from "vitest"
import { signup, internalId } from "../../../tests/helpers.js"
import { updateUserProfile, getUserBodyData, deleteAllUserData } from "../../auth/user.model.js"
import { clearDemoData, fillDemoData } from "../demo.model.js"
import { pool } from "../../../config/database.js"
import { getFriendsActiveSessionStatuses } from "../../social/sharing/sharing.model.js"
import { getClients, listTrainerRequests } from "../../trainer/trainer.model.js"
import { deleteUser, findTraineeForTrainer } from "../../auth/auth.model.js"
import { addExercise } from "../../programs/programs.model.js"
import { listConversations } from "../../messages/messages.model.js"
import { listScheduled } from "../../schedule/schedule.model.js"

afterEach(() => vi.unstubAllEnvs())

const days = [
  { dayNumber: 1, dayTitle: "A", exercises: [{ name: "DemoEdgeCurl", sets: 2 }] },
  { dayNumber: 2, dayTitle: "Empty", exercises: [] },
  { dayNumber: 3, dayTitle: "B", exercises: [{ name: "DemoEdgeCurl", sets: 1 }] },
]

describe("demo model edges", () => {
  it("skips an empty day and keeps an existing height", async () => {
    const id = await internalId((await signup("dmoedge")).user.id)
    await updateUserProfile(id, { height_cm: 165 } as never)
    const result = await fillDemoData(id, days, null)
    expect(result.sessions).toBeGreaterThan(0)
    expect(result.tracking).toBeGreaterThan(0)
    expect((await getUserBodyData(id)).heightCm).toBe(165)
  })

  it("seeds no tracking when the server keeps it on the device", async () => {
    vi.stubEnv("LOCAL_ONLY_FEATURES", "tracking,supplements")
    const id = await internalId((await signup("dmolocal")).user.id)
    expect((await fillDemoData(id, days, null)).tracking).toBe(0)
  })

  it("leaves the friends who share watch or trainer mid-workout", async () => {
    const id = await internalId((await signup("dmolive")).user.id)
    await fillDemoData(id, days, null)
    const [friends] = await pool.query<any[]>(
      "SELECT uuid, name FROM users WHERE demo_owner_id = ?",
      [id],
    )
    const statuses = await getFriendsActiveSessionStatuses(id, friends.map((f) => f.uuid))
    const live = friends
      .filter((f) => statuses[f.uuid]?.hasActiveSession)
      .map((f) => f.name)
      .sort()
    expect(live).toEqual(["All", "Half"])
  })

  it("lists the demo friends who granted trainer as clients", async () => {
    const id = await internalId((await signup("dmoclients")).user.id)
    await fillDemoData(id, days, null)
    const clients = await getClients(id, "2000-01-03")
    expect(clients).toHaveLength(1)
  })

  it("lets the owner act as the demo friends who granted trainer", async () => {
    const id = await internalId((await signup("dmoactas")).user.id)
    await fillDemoData(id, days, null)
    const clients = await getClients(id, "2000-01-03")
    const found = await Promise.all(clients.map((c) => findTraineeForTrainer(id, c.userId)))
    expect(found.map((t) => t?.uuid)).toEqual(clients.map((c) => c.userId))
  })

  it("seeds a conversation with each friend, the last hour unread, and none left after a refill", async () => {
    const id = await internalId((await signup("dmomsg")).user.id)
    await fillDemoData(id, days, null)
    await fillDemoData(id, days, null)
    const threads = await listConversations(id)
    expect(threads).toHaveLength(3)
    expect(threads.map((t) => t.unreadCount).sort()).toEqual([0, 1, 1])
    const [[{ n }]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM messages m JOIN users a ON a.id = m.sender_id JOIN users b ON b.id = m.recipient_id
       WHERE a.demo_owner_id = ? AND b.demo_owner_id = ?`,
      [id, id],
    )
    expect(Number(n)).toBe(6)
  })

  it("schedules the owner's workouts and suggestions both ways, all removed with the demo", async () => {
    const id = await internalId((await signup("dmosched")).user.id)
    await fillDemoData(id, days, null)
    const window = [new Date(Date.now() - 86_400_000), new Date(Date.now() + 10 * 86_400_000)] as const
    const mine = await listScheduled(id, ...window)
    expect(mine.map((e) => e.status).sort()).toEqual(["accepted", "accepted", "pending"])
    const [[all]] = await pool.query<any[]>("SELECT id FROM users WHERE demo_owner_id = ? AND name = 'All'", [id])
    expect((await listScheduled(all.id, ...window)).map((e) => e.status).sort()).toEqual(["accepted", "pending"])
    await clearDemoData(id)
    expect(await listScheduled(id, ...window)).toHaveLength(0)
  })

  it("seeds one received and one sent trainer request", async () => {
    const id = await internalId((await signup("dmotrreq")).user.id)
    await fillDemoData(id, days, null)
    expect((await listTrainerRequests(id, "received")).map((r) => r.fromUsername)).toHaveLength(1)
    expect(await listTrainerRequests(id, "sent")).toHaveLength(1)
  })

  it("marks some client workouts as logged by the owner", async () => {
    const id = await internalId((await signup("dmologged")).user.id)
    await fillDemoData(id, days, null)
    const [rows] = await pool.query<any[]>(
      `SELECT u.name, COUNT(w.logged_by_trainer_id) AS logged, COUNT(*) AS total
       FROM workouts w JOIN users u ON u.id = w.user_id
       WHERE u.demo_owner_id = ? AND w.end_time IS NOT NULL
       GROUP BY u.name HAVING logged > 0 ORDER BY u.name`,
      [id],
    )
    expect(rows.map((r) => r.name)).toEqual(["All"])
    for (const r of rows) expect(Number(r.logged)).toBeLessThan(Number(r.total))
    const [[owner]] = await pool.query<any[]>(
      `SELECT DISTINCT w.logged_by_trainer_id AS t FROM workouts w JOIN users u ON u.id = w.user_id
       WHERE u.demo_owner_id = ? AND w.logged_by_trainer_id IS NOT NULL`,
      [id],
    )
    expect(owner.t).toBe(id)
  })

  it("gives demo clients health consent so a trainer can log their workouts", async () => {
    const id = await internalId((await signup("dmoconsent")).user.id)
    await fillDemoData(id, days, null)
    const [client] = await getClients(id, "2000-01-03")
    expect((await findTraineeForTrainer(id, client.userId))?.healthConsentAt).toBeTruthy()
  })

  it("gives demo clients a stored program a trainer can add to", async () => {
    const id = await internalId((await signup("dmoprog")).user.id)
    await fillDemoData(id, days, null)
    const clients = await getClients(id, "2000-01-03")
    expect(clients.map((c) => c.activeProgramDayCount)).toEqual([2])
    const trainee = await findTraineeForTrainer(id, clients[0].userId)
    const added = await addExercise(trainee!.id, 1, "Me", { name: "Face Pull", sets: 3 })
    expect(added.exerciseIndex).toBe(3)
  })

  it("fills marketplace skins only the owner sees, removed with the demo, a data wipe or the account", async () => {
    const { user } = await signup("dmoskins")
    const id = await internalId(user.id)
    const count = async () =>
      (await pool.query<any[]>("SELECT COUNT(*) AS n FROM skins WHERE demo_for = ?", [user.id]))[0][0].n
    await fillDemoData(id, days, null)
    await fillDemoData(id, days, null)
    expect(await count()).toBe(3)
    const [[ratings]] = await pool.query<any[]>(
      "SELECT COUNT(*) AS n FROM skin_ratings r JOIN skins s ON s.id = r.skin_id WHERE s.demo_for = ?",
      [user.id],
    )
    expect(ratings.n).toBe(15)
    await clearDemoData(id)
    expect(await count()).toBe(0)
    await fillDemoData(id, days, null)
    await deleteAllUserData(id)
    expect(await count()).toBe(0)
    await fillDemoData(id, days, null)
    await deleteUser(id)
    expect(await count()).toBe(0)
  })

  it("removes a deleted account's name from the skins it published, which stay up", async () => {
    const { user } = await signup("skinauthor")
    const [r] = await pool.query<any>(
      "INSERT INTO skins (name, body, has_theme, has_boards, author_uuid, author_name) VALUES ('Kept', '{}', 1, 0, ?, 'skinauthor')",
      [user.id],
    )
    await deleteUser(await internalId(user.id))
    const [[skin]] = await pool.query<any[]>("SELECT author_uuid, author_name FROM skins WHERE id = ?", [r.insertId])
    expect(skin).toEqual({ author_uuid: null, author_name: null })
  })
})
