// Friends and sharing model paths the routes rarely reach, called directly:
// request races, self-targeting, grant caps, and the batch status reads.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { signup, internalId } from "../../../tests/helpers.js"
import { pool } from "../../../config/database.js"
import * as f from "../friends/friends.model.js"
import * as s from "../sharing/sharing.model.js"
import { createSession } from "../../workouts/workouts.model.js"

afterEach(() => vi.restoreAllMocks())

const user = async (prefix: string) => {
  const { user } = await signup(prefix)
  return { id: await internalId(user.id), uuid: user.id as string }
}

async function befriend(a: number, b: number) {
  await f.acceptFriendRequest(b, await f.sendFriendRequest(a, b))
}

/** Rejects the next INSERT INTO friendships with `err`, once. */
function failFriendshipInsert(err: object) {
  const real = pool.execute.bind(pool)
  vi.spyOn(pool, "execute").mockImplementation(((sql: string, p: unknown) => {
    if (sql.includes("INSERT INTO friendships")) {
      vi.restoreAllMocks()
      return Promise.reject(Object.assign(new Error("injected"), err))
    }
    return real(sql, p as never)
  }) as never)
}

describe("friends model edges", () => {
  it("names every kind of duplicate request", async () => {
    const [a, b] = [await user("fra"), await user("frb")]
    const id = await f.sendFriendRequest(a.id, b.id)
    await expect(f.sendFriendRequest(a.id, b.id)).rejects.toMatchObject({ code: "REQUEST_PENDING" })
    await expect(f.sendFriendRequest(b.id, a.id)).rejects.toMatchObject({ code: "REQUEST_INCOMING" })
    await f.acceptFriendRequest(b.id, id)
    expect(await f.acceptFriendRequest(b.id, id)).toBe(true)
    await expect(f.sendFriendRequest(a.id, b.id)).rejects.toMatchObject({ code: "ALREADY_FRIENDS" })
  })

  it("reports a duplicate whose row is already gone, and rethrows other insert errors", async () => {
    const [a, b] = [await user("frc"), await user("frd")]
    failFriendshipInsert({ code: "ER_DUP_ENTRY" })
    await expect(f.sendFriendRequest(a.id, b.id)).rejects.toMatchObject({ code: "REQUEST_PENDING", details: null })
    failFriendshipInsert({ code: "ER_LOCK_DEADLOCK" })
    await expect(f.sendFriendRequest(a.id, b.id)).rejects.toThrow("injected")
  })

  it("refuses a request across a block, and self-targeted blocks and reports", async () => {
    const [a, b] = [await user("fre"), await user("frf")]
    await f.blockUser(a.id, b.id)
    await expect(f.sendFriendRequest(b.id, a.id)).rejects.toThrow()
    await expect(f.blockUser(a.id, a.id)).rejects.toThrow("Cannot block yourself")
    await expect(f.reportUser(a.id, a.id, "spam")).rejects.toThrow("Cannot report yourself")
    await f.reportUser(a.id, b.id, "spam")
    await expect(f.reportUser(a.id, b.id, "spam")).rejects.toMatchObject({ code: "REPORT_ALREADY_FILED" })
  })

  it("404s removing a non-friend, caps search length, and keeps reports when retention is 0", async () => {
    const [a, b] = [await user("frg"), await user("frh")]
    await expect(f.removeFriend(a.id, b.id)).rejects.toThrow("Friendship")
    await expect(f.searchUsers("x".repeat(51), a.id)).rejects.toThrow("must not exceed 50")
    expect(await f.purgeOldReports(0)).toBe(0)
    await expect(f.acceptFriendRequest(a.id, 999_999_999)).rejects.toThrow("Friend request")
    await expect(f.rejectFriendRequest(a.id, 999_999_999)).rejects.toThrow("Friend request")
  })
})

describe("sharing model edges", () => {
  let a: { id: number; uuid: string }
  let b: { id: number; uuid: string }

  beforeAll(async () => {
    ;[a, b] = [await user("sha"), await user("shb")]
    await befriend(a.id, b.id)
  })

  it("rejects an unknown permission type", async () => {
    await expect(s.grantPermission(a.id, b.id, "everything" as never)).rejects.toThrow("Invalid permission type")
  })

  it("caps grants per user and program grants per user", async () => {
    const owner = await user("shcap")
    const tag = `cap${Date.now().toString(36)}`
    await pool.query(`INSERT INTO users (uuid, username, email, password_hash, name) VALUES ?`, [
      Array.from({ length: 300 }, (_, i) => [crypto.randomUUID(), `${tag}${i}`, `${tag}${i}@x.co`, "x", "x"]),
    ])
    const [rows] = await pool.query<never[]>(`SELECT id FROM users WHERE username LIKE ? ORDER BY id`, [`${tag}%`])
    const ids = (rows as { id: number }[]).map((r) => r.id)
    await pool.query(`INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type) VALUES ?`, [
      ids.slice(0, 25).map((id) => [owner.id, id, "program"]),
    ])
    await expect(s.grantPermission(owner.id, ids[25]!, "program")).rejects.toThrow("at most 25 friends")
    // Re-granting an existing triple is never capped.
    await s.grantPermission(owner.id, ids[0]!, "program")

    await pool.query(`INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type) VALUES ?`, [
      ids.slice(25, 300).map((id) => [owner.id, id, "history"]),
    ])
    await expect(s.grantPermission(owner.id, ids[0]!, "history")).rejects.toThrow("at most 300 sharing permissions")
  })

  it("lists grants without payloads, and returns a null payload", async () => {
    const id = await s.grantPermission(a.id, b.id, "program")
    expect(await s.getPermissions(a.id, "granted", { includePayload: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, payload: null })]),
    )
    expect(await s.getPermissionPayload(b.id, id)).toEqual({ payload: null })
  })

  it("returns no friend sessions with timings when there are none", async () => {
    expect(await s.getFriendSessions(b.id, 10, true)).toEqual([])
  })

  it("404s declining a missing invite, and stores a full exercise list", async () => {
    await expect(s.declineInvite(999_999_999, a.id)).rejects.toThrow("Invite")
    const [c, d] = [await user("shc"), await user("shd")]
    await befriend(c.id, d.id)
    await s.grantPermission(c.id, d.id, "joint_session")
    await s.grantPermission(d.id, c.id, "joint_session")
    const { jointSessionId } = await s.acceptInvite(await s.createJointInvite(c.id, d.id), d.id)
    expect(
      await s.updateParticipantProgress(jointSessionId, c.id, { exerciseIndex: 1, exerciseNames: ["Squat", "Row"] }),
    ).toMatchObject({ exerciseName: "Row", exerciseNames: ["Squat", "Row"] })
    expect(await s.updateParticipantProgress(jointSessionId, c.id, { exerciseIndex: 5, exerciseNames: ["Squat"] })).toMatchObject({
      exerciseName: null,
    })
    expect(await s.updateParticipantProgress(jointSessionId, c.id, { exerciseIndex: 0, exerciseName: "Squat" })).toMatchObject({
      exerciseName: "Squat",
      exerciseNames: null,
    })
    expect(await s.getJointSession(999_999_999)).toBeNull()
    await expect(s.endJointSession(999_999_999, c.id)).rejects.toThrow("Joint session participant")
  })

  it("lists only watchers when asked", async () => {
    await s.grantPermission(a.id, b.id, "watch_session")
    expect(await s.getLiveAudience(a.id, "watchers")).toEqual([expect.objectContaining({ uuid: b.uuid, permissionType: "watch_session" })])
  })

  it("reads active-session statuses for no one, non-friends, and a friend with two open workouts", async () => {
    expect(await s.getUserActiveSessionStatus(b.id)).toMatchObject({ hasActiveSession: false })
    expect(await s.getFriendsActiveSessionStatuses(a.id, [])).toEqual({})
    const stranger = await user("shz")
    expect(await s.getFriendsActiveSessionStatuses(a.id, [stranger.uuid])).toEqual({})

    await s.grantPermission(b.id, a.id, "watch_session")
    await createSession(b.id, 1, "Old", new Date(Date.now() - 3_600_000))
    const newest = await createSession(b.id, 2, "New", new Date())
    expect((await s.getFriendsActiveSessionStatuses(a.id, [b.uuid]))[b.uuid]).toMatchObject({ sessionId: newest })
  })
})
