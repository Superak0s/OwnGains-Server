// The expiring stores the 5-minute cleanup job sweeps besides stale workouts:
// refresh tokens, joint-session invites and sessions, and friend-request
// cooldowns. Rows are written directly with backdated timestamps. Every
// assertion is scoped to ids this file created, since other files share the DB.

import { describe, it, expect } from "vitest"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { pool } from "../../config/database.js"
import { createUser } from "../../features/auth/auth.model.js"
import { uniqueName } from "../../tests/helpers.js"
import { runStaleSessionCleanup } from "../sessionCleanup.js"
import { blockUser } from "../../features/social/friends/friends.model.js"

async function user(): Promise<number> {
  const name = uniqueName("purge")
  return createUser(name, `${name}@test.local`, "Passw0rd-123")
}

async function insert(sql: string, params: (string | number)[]): Promise<number> {
  const [r] = await pool.execute<ResultSetHeader>(sql, params)
  return r.insertId
}

async function jointSession(a: number, b: number, status: string, ageSql: string) {
  const id = await insert(
    "INSERT INTO joint_sessions (created_by, status) VALUES (?, ?)",
    [a, status],
  )
  await pool.execute(
    "INSERT INTO joint_session_participants (joint_session_id, user_id) VALUES (?, ?), (?, ?)",
    [id, a, id, b],
  )
  // Aged only once its participants exist: a purge from another file can
  // delete an old session between the two inserts.
  await pool.execute(`UPDATE joint_sessions SET created_at = NOW() - INTERVAL ${ageSql} WHERE id = ?`, [id])
  return id
}

async function statusOf(id: number): Promise<string | undefined> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT status FROM joint_sessions WHERE id = ?",
    [id],
  )
  return rows[0]?.status
}

describe("expiring-store purges", () => {
  it("sweeps what has expired and keeps what hasn't", async () => {
    const a = await user()
    const b = await user()

    const oldInvite = await insert(
      `INSERT INTO joint_session_invites (from_user_id, to_user_id, expires_at)
       VALUES (?, ?, NOW() - INTERVAL 2 DAY)`,
      [a, b],
    )
    const liveInvite = await insert(
      `INSERT INTO joint_session_invites (from_user_id, to_user_id, expires_at)
       VALUES (?, ?, NOW() + INTERVAL 2 MINUTE)`,
      [b, a],
    )
    const abandoned = await jointSession(a, b, "active", "2 DAY")
    const running = await jointSession(a, b, "active", "10 MINUTE")
    const longEnded = await jointSession(a, b, "ended", "8 DAY")
    const recentlyEnded = await jointSession(a, b, "ended", "1 DAY")

    const c = await user()
    const d = await user()
    const e = await user()
    await pool.execute(
      `INSERT INTO friend_request_cooldowns (requester_id, recipient_id, kind, created_at) VALUES
         (?, ?, 'cancelled', NOW() - INTERVAL 2 HOUR),
         (?, ?, 'declined',  NOW() - INTERVAL 2 DAY),
         (?, ?, 'declined',  NOW() - INTERVAL 31 DAY)`,
      [c, a, d, a, e, a],
    )

    const expiredToken = await insert(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES (?, SHA2(UUID(), 256), UUID(), NOW() - INTERVAL 1 HOUR)`,
      [a],
    )
    const liveToken = await insert(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES (?, SHA2(UUID(), 256), UUID(), NOW() + INTERVAL 1 DAY)`,
      [a],
    )

    await runStaleSessionCleanup()

    const [invites] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM joint_session_invites WHERE id IN (?)",
      [[oldInvite, liveInvite]],
    )
    expect(invites.map((r) => r.id)).toEqual([liveInvite])

    expect(await statusOf(abandoned)).toBe("ended")
    expect(await statusOf(running)).toBe("active")
    expect(await statusOf(longEnded)).toBeUndefined()
    expect(await statusOf(recentlyEnded)).toBe("ended")
    const [orphans] = await pool.execute<RowDataPacket[]>(
      "SELECT 1 FROM joint_session_participants WHERE joint_session_id = ?",
      [longEnded],
    )
    expect(orphans).toHaveLength(0)

    const [cooldowns] = await pool.execute<RowDataPacket[]>(
      "SELECT requester_id FROM friend_request_cooldowns WHERE recipient_id = ?",
      [a],
    )
    expect(cooldowns.map((r) => r.requester_id)).toEqual([d])

    const [tokens] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM refresh_tokens WHERE id IN (?)",
      [[expiredToken, liveToken]],
    )
    expect(tokens.map((r) => r.id)).toEqual([liveToken])
  })

  it("a block ends only the pair's own active joint sessions", async () => {
    const a = await user()
    const b = await user()
    const c = await user()
    const pair = await jointSession(a, b, "active", "1 MINUTE")
    const other = await jointSession(a, c, "active", "1 MINUTE")

    await blockUser(a, b)

    expect(await statusOf(pair)).toBe("ended")
    expect(await statusOf(other)).toBe("active")
  })
})
