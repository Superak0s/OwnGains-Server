import { pool, withTransaction } from "@/config/database.js"
import { envInt } from "@/config/env.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import {
  AppError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import type {
  Friend,
  FriendRequest,
  UserSearchResult,
} from "../social.types.js"

type BlockedUser = { id: string; username: string; name: string; blockedAt: Date }

// Ceiling on the pending-request lists so a user spammed with requests still
// gets a bounded response.
const PENDING_REQUESTS_LIMIT = 500

/** Outgoing requests one user may have waiting at once. */
export const MAX_PENDING_SENT = 50

/**
 * How long a sender must wait before asking the same person again. A decline
 * deletes the row, so without this the sender could re-send (and re-push a
 * notification) immediately, forever. A cancelled request gets a short one,
 * enough to stop a send/cancel loop from being a notification cannon.
 */
const DECLINE_COOLDOWN_DAYS = 30
const CANCEL_COOLDOWN_MINUTES = 60

// Same wording for a block, a cooldown and a declined request: the sender
// must not be able to tell which one stopped them.
const CANNOT_REQUEST = "Cannot send a friend request to this user"

/**
 * One row per pair, stored canonically: user_id = LEAST(a,b),
 * friend_id = GREATEST(a,b), with requested_by carrying the direction. That
 * makes uq_friendship the mutual-exclusion primitive: two simultaneous A→B and
 * B→A requests collide on the unique key instead of both passing a "no existing
 * row" read, which is what the advisory GET_LOCK here used to be for.
 */
export async function sendFriendRequest(
  fromUserId: number,
  toUserId: number,
): Promise<number> {
  const [blocks] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM user_blocks
     WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
     LIMIT 1`,
    [fromUserId, toUserId, toUserId, fromUserId],
  )
  // Deliberately the same message in both directions: telling the sender
  // "they blocked you" would leak the block back to the person it protects
  // the other user from.
  if (blocks.length) throw new ForbiddenError(CANNOT_REQUEST)

  const [cooldown] = await pool.execute<RowDataPacket[]>(
    `SELECT 1 FROM friend_request_cooldowns
     WHERE requester_id = ? AND recipient_id = ?
       AND ((kind = 'declined' AND created_at > NOW() - INTERVAL ${DECLINE_COOLDOWN_DAYS} DAY)
         OR (kind = 'cancelled' AND created_at > NOW() - INTERVAL ${CANCEL_COOLDOWN_MINUTES} MINUTE))`,
    [fromUserId, toUserId],
  )
  if (cooldown.length) throw new ForbiddenError(CANNOT_REQUEST)

  // Counted before the insert, so two racing requests can overshoot by one,
  // harmless for a spam cap.
  const [[pending]] = await pool.execute<(RowDataPacket & { n: number })[]>(
    `SELECT COUNT(*) AS n FROM friendships
     WHERE requested_by = ? AND status = 'pending'`,
    [fromUserId],
  )
  if (Number(pending.n) >= MAX_PENDING_SENT)
    throw new AppError(
      `You have ${MAX_PENDING_SENT} friend requests waiting. Cancel some or wait for replies`,
      429,
      null,
      "TOO_MANY_PENDING_REQUESTS",
    )

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO friendships (user_id, friend_id, requested_by)
       VALUES (LEAST(?, ?), GREATEST(?, ?), ?)`,
      [fromUserId, toUserId, fromUserId, toUserId, fromUserId],
    )
    return result.insertId
  } catch (err) {
    if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err
  }

  const [existing] = await pool.execute<RowDataPacket[]>(
    `SELECT id, status, requested_by AS requestedBy FROM friendships
     WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)`,
    [fromUserId, toUserId, fromUserId, toUserId],
  )
  const row = existing[0]
  // All three are 409s that only prose told apart. The incoming case is the one
  // that matters: the caller lost the race, and the fix is to accept the
  // request they already have, so hand back the id they need to do it with.
  if (row?.status === "accepted")
    throw new ConflictError("Already friends", "ALREADY_FRIENDS", {
      friendshipId: row.id,
    })
  if (row && row.requestedBy !== fromUserId)
    throw new ConflictError(
      "This user has already sent you a friend request. Accept it instead",
      "REQUEST_INCOMING",
      { friendshipId: row.id },
    )
  throw new ConflictError(
    "Friend request already pending",
    "REQUEST_PENDING",
    row ? { friendshipId: row.id } : null,
  )
}

export async function acceptFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    // Either column may hold the caller now, so the recipient is defined as
    // "in this pair, and not the one who asked".
    `UPDATE friendships SET status = 'accepted', accepted_at = NOW()
     WHERE id = ? AND ? IN (user_id, friend_id) AND requested_by <> ?
       AND status = 'pending'`,
    [friendshipId, userId, userId],
  )
  if (result.affectedRows > 0) {
    // Friends now: whatever cooldown either side held is moot.
    await pool.execute(
      `DELETE c FROM friend_request_cooldowns c JOIN friendships f ON f.id = ?
       WHERE (c.requester_id = f.user_id AND c.recipient_id = f.friend_id)
          OR (c.requester_id = f.friend_id AND c.recipient_id = f.user_id)`,
      [friendshipId],
    )
  } else {
    // Already accepted: a double-tapped button or a retried sync. Reporting
    // "not found" for something that just succeeded is worse than a no-op.
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id FROM friendships
       WHERE id = ? AND ? IN (user_id, friend_id) AND status = 'accepted'`,
      [friendshipId, userId],
    )
    if (!rows.length) throw new NotFoundError("Friend request")
  }
  return true
}

/**
 * Reject an incoming request, or cancel one you sent. Both are "delete this
 * pending row", and without the cancel a request sent to the wrong username
 * was permanent: uq_friendship blocks a re-request and POST /request answers
 * 409 forever, so the only escape was blocking the person.
 */
export async function rejectFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<
      (RowDataPacket & { requester: number; recipient: number })[]
    >(
      `SELECT requested_by AS requester,
              IF(requested_by = user_id, friend_id, user_id) AS recipient
       FROM friendships
       WHERE id = ? AND ? IN (user_id, friend_id) AND status = 'pending'
       FOR UPDATE`,
      [friendshipId, userId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError("Friend request")
    await conn.execute(`DELETE FROM friendships WHERE id = ?`, [friendshipId])
    // The recipient saying no starts the long cooldown. The sender taking it
    // back starts the short one. Either way it is the requester who waits.
    await conn.execute(
      `INSERT INTO friend_request_cooldowns (requester_id, recipient_id, kind)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), created_at = NOW()`,
      [row.requester, row.recipient, userId === row.requester ? "cancelled" : "declined"],
    )
    return true
  })
}

/**
 * Unfriending must tear down the access grants too, not just the friendship
 * row (see severPair). Everything goes in one transaction so access can't
 * remain after a half-applied teardown.
 */
export async function removeFriend(
  userId: number,
  friendId: number,
): Promise<boolean> {
  return withTransaction(async (conn) => {
    const [result] = await conn.execute<ResultSetHeader>(
      `DELETE FROM friendships
       WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)
         AND status = 'accepted'`,
      [userId, friendId, userId, friendId],
    )
    if (result.affectedRows === 0) throw new NotFoundError("Friendship")
    await severPair(conn, userId, friendId)
    return true
  })
}

/**
 * Everything that must go when two people stop being friends, whichever way
 * it happens (unfriend or block). removeFriend and blockUser each carried their
 * own copy of these statements and had already drifted once: removeFriend
 * went without the invite delete, so an invite sent just before an unfriend
 * could still be accepted, and this is the path that revokes trainer access.
 */
async function severPair(conn: PoolConnection, a: number, b: number): Promise<void> {
  // A `trainer` grant is read/write against the other person's sessions,
  // program and analytics, and leaving it behind kept an unfriended trainer in.
  await conn.execute(
    `DELETE FROM sharing_permissions WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
    [a, b, b, a],
  )
  // acceptInvite re-checks recipient, status and expiry but not friendship,
  // so an invite sent just before the split could still be accepted inside
  // its 120s TTL: a joint session between two non-friends.
  await conn.execute(
    `DELETE FROM joint_session_invites WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
    [a, b, b, a],
  )
  // A joint session is stateful, unlike live spectating, which re-runs the
  // friendship join on every broadcast, so severing the relationship has to
  // end it explicitly. Without this the pair kept streaming each other's
  // exercise names over WS after a block, with no route to stop it.
  //
  // Reached through both participant rows (uq_jsp_participant, idx_jsp_user),
  // so it locks only this pair's sessions. The old form filtered on the
  // unindexed status column with a correlated COUNT(*), which scanned (and
  // under REPEATABLE READ locked) every row of joint_sessions until commit.
  await conn.execute(
    `UPDATE joint_sessions js
       JOIN joint_session_participants pa ON pa.joint_session_id = js.id AND pa.user_id = ?
       JOIN joint_session_participants pb ON pb.joint_session_id = js.id AND pb.user_id = ?
        SET js.status = 'ended'
      WHERE js.status = 'active'`,
    [a, b],
  )
}

export async function getFriends(userId: number): Promise<Friend[]> {
  const [rows] = await pool.execute<(Friend & RowDataPacket)[]>(
    // The pair is ordered, so "the other one" is one IF and one join rather
    // than a CASE over two copies of the users table.
    `SELECT f.id AS friendshipId, f.created_at AS friendsSince,
            u.uuid AS friendUserId, u.username, u.name
     FROM friendships f
     JOIN users u ON u.id = IF(f.user_id = ?, f.friend_id, f.user_id)
     WHERE ? IN (f.user_id, f.friend_id) AND f.status = 'accepted'
     ORDER BY f.accepted_at DESC LIMIT 500`,
    [userId, userId],
  )
  return rows
}

export async function getPendingRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<(FriendRequest & RowDataPacket)[]>(
    // Incoming: someone else asked, and the caller is the other half of the pair.
    `SELECT f.id AS friendshipId, u.uuid AS userId,
            f.created_at AS createdAt, u.username, u.name
     FROM friendships f JOIN users u ON u.id = f.requested_by
     WHERE ? IN (f.user_id, f.friend_id) AND f.requested_by <> ?
       AND f.status = 'pending'
     ORDER BY f.created_at DESC LIMIT ?`,
    [userId, userId, PENDING_REQUESTS_LIMIT],
  )
  return rows
}

export async function getSentRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<(FriendRequest & RowDataPacket)[]>(
    `SELECT f.id AS friendshipId,
            u.uuid AS friendId,
            f.created_at AS createdAt, u.username, u.username AS name
     FROM friendships f
     JOIN users u ON u.id = IF(f.user_id = ?, f.friend_id, f.user_id)
     WHERE f.requested_by = ? AND f.status = 'pending'
     ORDER BY f.created_at DESC LIMIT ?`,
    [userId, userId, PENDING_REQUESTS_LIMIT],
  )
  return rows
}

const SEARCH_MIN_LENGTH = 3

/**
 * Find people to add, by USERNAME PREFIX only.
 *
 * It used to be `username LIKE '%x%' OR name LIKE '%x%'` from two characters,
 * which a few hundred queries turned into the instance's whole member list
 * (real names included), and which no index could serve. A left-anchored
 * `LIKE 'abc%'` is a range scan on uq_users_username, and a stranger's real
 * name is neither searched nor returned: `name` carries the username unless
 * the two are already friends (kept a string so older clients still render).
 */
export async function searchUsers(
  searchTerm: string,
  currentUserId: number,
  limit = 10,
): Promise<UserSearchResult[]> {
  if (searchTerm.length < SEARCH_MIN_LENGTH)
    throw new ValidationError(
      `Search term must be at least ${SEARCH_MIN_LENGTH} characters`,
    )
  if (searchTerm.length > 50)
    throw new ValidationError("Search term must not exceed 50 characters")

  // The term is bound as a parameter, so this was never injectable, but it
  // is bound *inside* a LIKE, so an unescaped % or _ is still a pattern.
  // `?q=%%%` would match every row again.
  const pattern = searchTerm.replace(/[\\%_]/g, String.raw`\$&`) + "%"

  const [rows] = await pool.execute<(UserSearchResult & RowDataPacket)[]>(
    `SELECT u.uuid AS id, u.username,
       IF(f.status = 'accepted', u.name, u.username) AS name,
       CASE
         WHEN f.status = 'accepted' THEN 'friend'
         WHEN f.status = 'pending' AND f.requested_by = ? THEN 'request_sent'
         WHEN f.status = 'pending' THEN 'request_received'
         ELSE 'none'
       END AS friendshipStatus
     FROM users u
     LEFT JOIN friendships f
       ON f.user_id = LEAST(?, u.id) AND f.friend_id = GREATEST(?, u.id)
     WHERE u.username LIKE ? AND u.id != ? AND u.disabled_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = ?)
       )
     ORDER BY (u.username = ?) DESC, u.username
     LIMIT ?`,
    [
      currentUserId,
      currentUserId,
      currentUserId,
      pattern,
      currentUserId,
      currentUserId,
      currentUserId,
      searchTerm,
      limit,
    ],
  )
  return rows
}

/**
 * Blocking is the one action that has to work on its own: with no central
 * moderator, severing the relationship *is* the remedy. So rather than
 * teaching every read path about blocks, a block tears down everything that
 * could still connect the pair: the friendship, both directions of sharing
 * permissions, and any outstanding joint-session invite. `hasPermission`
 * then answers false for watching, history and joint sessions without
 * knowing blocks exist.
 *
 * ponytail: a joint session already running when the block is applied keeps
 * streaming until it ends. Kick the live socket here if that ever matters.
 */
export async function blockUser(
  blockerId: number,
  blockedId: number,
): Promise<void> {
  if (blockerId === blockedId) {
    throw new ValidationError("Cannot block yourself")
  }

  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`,
      [blockerId, blockedId],
    )
    await conn.execute(
      `DELETE FROM friendships
       WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)`,
      [blockerId, blockedId, blockerId, blockedId],
    )
    await severPair(conn, blockerId, blockedId)
  })
}

export async function unblockUser(
  blockerId: number,
  blockedId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`,
    [blockerId, blockedId],
  )
  return result.affectedRows > 0
}

export async function getBlockedUsers(userId: number): Promise<BlockedUser[]> {
  const [rows] = await pool.execute<(BlockedUser & RowDataPacket)[]>(
    // Display names are for friends only, as in search.
    `SELECT u.uuid AS id, u.username, u.username AS name, b.created_at AS blockedAt
     FROM user_blocks b JOIN users u ON b.blocked_id = u.id
     WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT 500`,
    [userId],
  )
  return rows
}

export const REPORT_REASONS = [
  "harassment",
  "spam",
  "impersonation",
  "inappropriate",
  "other",
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]

export async function reportUser(
  reporterId: number,
  reportedId: number,
  reason: ReportReason,
  details?: string,
): Promise<number> {
  if (reporterId === reportedId) {
    throw new ValidationError("Cannot report yourself")
  }
  // Nothing but the global 200/min limiter stood between one user and filling
  // user_reports, which the operator reads by hand. One report per pair per
  // day is plenty for a self-hosted instance.
  const [recent] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM user_reports
     WHERE reporter_id = ? AND reported_id = ?
       AND created_at > NOW() - INTERVAL 1 DAY LIMIT 1`,
    [reporterId, reportedId],
  )
  if (recent.length)
    throw new ConflictError(
      "You have already reported this user today",
      "REPORT_ALREADY_FILED",
    )
  // The reported user's uuid and username are copied onto the report, so it
  // still says who it was about after that account is deleted (the FK then
  // goes NULL rather than taking the report with it).
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO user_reports
       (reporter_id, reported_id, reported_uuid, reported_username, reason, details)
     SELECT ?, u.id, u.uuid, u.username, ?, ? FROM users u WHERE u.id = ?`,
    [reporterId, reason, details?.slice(0, 1000) || null, reportedId],
  )
  return result.insertId
}

interface ReportRow extends RowDataPacket {
  id: number
  reason: string
  details: string | null
  created_at: Date
  /** null once the reporter deleted their account. */
  reporter_uuid: string | null
  reporter_username: string | null
  reported_uuid: string | null
  reported_username: string | null
  /** Whether the reported account still exists / is currently suspended. */
  reported_exists: number
  reported_disabled: number
}

/**
 * Reports on this instance, newest first, for `owngains reports` and the
 * admin API. The reported side falls back to the snapshot taken at filing
 * time once the account is gone.
 */
export async function listReports(limit = 100): Promise<ReportRow[]> {
  const [rows] = await pool.execute<ReportRow[]>(
    `SELECT r.id, r.reason, r.details, r.created_at,
            reporter.uuid AS reporter_uuid,
            reporter.username AS reporter_username,
            COALESCE(reported.uuid, r.reported_uuid) AS reported_uuid,
            COALESCE(reported.username, r.reported_username) AS reported_username,
            reported.id IS NOT NULL AS reported_exists,
            reported.disabled_at IS NOT NULL AS reported_disabled
     FROM user_reports r
     LEFT JOIN users reporter ON r.reporter_id = reporter.id
     LEFT JOIN users reported ON r.reported_id = reported.id
     ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    [limit],
  )
  return rows
}

/**
 * Drop friend-request cooldowns that no longer block anything: a 'cancelled'
 * one after CANCEL_COOLDOWN_MINUTES, a 'declined' one after
 * DECLINE_COOLDOWN_DAYS. Only an accept used to delete them. Run by the
 * 5-minute cleanup job. The leading created_at range uses idx_frc_created.
 */
/**
 * Reports are kept after both accounts are deleted and name the reported user, so they can't be
 * kept forever (GDPR storage limitation). REPORT_RETENTION_DAYS, 0 = never.
 */
export async function purgeOldReports(
  days = envInt("REPORT_RETENTION_DAYS", 365),
  batch = 5000,
): Promise<number> {
  if (days === 0) return 0
  const [r] = await pool.execute<ResultSetHeader>(
    `DELETE FROM user_reports
     WHERE created_at < NOW() - INTERVAL ${days | 0} DAY
     LIMIT ${Number(batch) | 0}`,
  )
  return r.affectedRows
}

export async function purgeExpiredCooldowns(batch = 5000): Promise<number> {
  const [r] = await pool.execute<ResultSetHeader>(
    `DELETE FROM friend_request_cooldowns
     WHERE created_at < NOW() - INTERVAL ${CANCEL_COOLDOWN_MINUTES} MINUTE
       AND (kind = 'cancelled'
            OR created_at < NOW() - INTERVAL ${DECLINE_COOLDOWN_DAYS} DAY)
     LIMIT ${Number(batch) | 0}`,
  )
  return r.affectedRows
}
