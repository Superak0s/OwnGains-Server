import { pool, parseMySQLDate } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ForbiddenError, NotFoundError } from "@/middleware/errorHandler.js"
import { ARE_FRIENDS } from "@/features/social/friends/friends.model.js"
import { parseUuidParam } from "@/middleware/validation.js"

/** A message as the API returns it, seen from the reader's side. */
export interface Message {
  id: number
  fromMe: boolean
  body: string
  createdAt: string
  readAt: string | null
  editedAt: string | null
}

/** How the other person relates to the reader through a trainer grant. */
export type Relation = "trainer" | "client" | null

/** One row of the conversation list. */
export interface Conversation {
  userUuid: string
  username: string
  lastMessage: { body: string; createdAt: string; fromMe: boolean }
  unreadCount: number
  relation: Relation
}

/** The other side of a thread, with whether a new message may be sent to them. */
export interface Peer {
  id: number
  uuid: string
  username: string
  allowed: boolean
}

interface MessageRow extends RowDataPacket {
  id: number
  sender_id: number
  body: string
  created_at: string
  read_at: string | null
  edited_at: string | null
}

const iso = (v: string) => parseMySQLDate(v).toISOString()

const toMessage = (r: MessageRow, viewerId: number): Message => ({
  id: r.id,
  fromMe: r.sender_id === viewerId,
  body: r.body,
  createdAt: iso(r.created_at),
  readAt: r.read_at == null ? null : iso(r.read_at),
  editedAt: r.edited_at == null ? null : iso(r.edited_at),
})

const MESSAGE_COLS = "id, sender_id, body, created_at, read_at, edited_at"

// A trainer grant in either direction allows messaging without a friendship,
// so revoking it stops new messages while the history stays readable.
const TRAINER_EITHER_WAY = `EXISTS(SELECT 1 FROM sharing_permissions sp
     WHERE sp.permission_type = 'trainer'
       AND ((sp.from_user_id = u.id AND sp.to_user_id = ?)
         OR (sp.from_user_id = ? AND sp.to_user_id = u.id)))`

/**
 * Resolves the other user of a thread from the raw `:userUuid` param.
 *
 * @throws ValidationError for a malformed uuid.
 * @throws NotFoundError for an unknown, suspended (unless it is the viewer's demo friend) or own uuid, so a probe can't tell them apart.
 */
export async function resolvePeer(viewerId: number, value: unknown): Promise<Peer> {
  const uuid = parseUuidParam(value, "user id")
  const [rows] = await pool.execute<
    (RowDataPacket & { id: number; username: string; friends: number; trainer: number })[]
  >(
    `SELECT u.id, u.username,
       ${ARE_FRIENDS} AS friends,
       ${TRAINER_EITHER_WAY} AS trainer
     FROM users u WHERE u.uuid = ? AND (u.disabled_at IS NULL OR u.demo_owner_id = ?) AND u.id <> ?`,
    [viewerId, viewerId, viewerId, viewerId, uuid, viewerId, viewerId],
  )
  const row = rows[0]
  if (!row) throw new NotFoundError("User")
  return { id: row.id, uuid, username: row.username, allowed: !!row.friends || !!row.trainer }
}

/** Every thread the viewer has, most recent first. */
export async function listConversations(viewerId: number): Promise<Conversation[]> {
  const [rows] = await pool.execute<
    (RowDataPacket & {
      uuid: string
      username: string
      body: string
      created_at: string
      sender_id: number
      unread: number
      is_trainer: number
      is_client: number
    })[]
  >(
    `SELECT u.uuid, u.username, m.body, m.created_at, m.sender_id,
       (SELECT COUNT(*) FROM messages r
         WHERE r.recipient_id = ? AND r.sender_id = u.id AND r.read_at IS NULL) AS unread,
       EXISTS(SELECT 1 FROM sharing_permissions sp
               WHERE sp.from_user_id = ? AND sp.to_user_id = u.id
                 AND sp.permission_type = 'trainer') AS is_trainer,
       EXISTS(SELECT 1 FROM sharing_permissions sp
               WHERE sp.from_user_id = u.id AND sp.to_user_id = ?
                 AND sp.permission_type = 'trainer') AS is_client
     FROM (SELECT other_id, MAX(last_id) AS last_id FROM (
             SELECT recipient_id AS other_id, MAX(id) AS last_id FROM messages
              WHERE sender_id = ? GROUP BY recipient_id
             UNION ALL
             SELECT sender_id, MAX(id) FROM messages
              WHERE recipient_id = ? GROUP BY sender_id
           ) t GROUP BY other_id) c
     JOIN messages m ON m.id = c.last_id
     JOIN users u ON u.id = c.other_id
     ORDER BY c.last_id DESC`,
    [viewerId, viewerId, viewerId, viewerId, viewerId],
  )
  return rows.map((r) => ({
    userUuid: r.uuid,
    username: r.username,
    lastMessage: { body: r.body, createdAt: iso(r.created_at), fromMe: r.sender_id === viewerId },
    unreadCount: Number(r.unread),
    relation: r.is_trainer ? "trainer" : r.is_client ? "client" : null,
  }))
}

/**
 * One page of a thread, newest first.
 *
 * @param before - Only messages with a smaller id, for paging back.
 */
export async function listMessages(
  viewerId: number,
  otherId: number,
  before: number | undefined,
  limit: number,
): Promise<Message[]> {
  const [rows] = await pool.execute<MessageRow[]>(
    `SELECT ${MESSAGE_COLS} FROM messages
      WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ${before ? "AND id < ?" : ""}
      ORDER BY id DESC LIMIT ${limit | 0}`,
    [viewerId, otherId, otherId, viewerId, ...(before ? [before] : [])],
  )
  return rows.map((r) => toMessage(r, viewerId))
}

/** Stores a message and returns it as the sender sees it. */
export async function sendMessage(senderId: number, recipientId: number, body: string): Promise<Message> {
  const [res] = await pool.execute<ResultSetHeader>(
    "INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)",
    [senderId, recipientId, body],
  )
  const [rows] = await pool.execute<MessageRow[]>(
    `SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`,
    [res.insertId],
  )
  return toMessage(rows[0], senderId)
}

/**
 * Marks everything the other user sent the reader as read.
 *
 * @returns How many messages changed, so an already-read thread sends no event.
 */
export async function markRead(readerId: number, senderId: number): Promise<number> {
  const [res] = await pool.execute<ResultSetHeader>(
    "UPDATE messages SET read_at = NOW() WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL",
    [readerId, senderId],
  )
  return res.affectedRows
}

/** How long after sending a message its author may still edit it. */
export const EDIT_WINDOW_MINUTES = 15

/**
 * Replaces the text of a message the sender wrote to the recipient.
 *
 * @throws NotFoundError when the sender wrote no such message to them, ForbiddenError once the edit window has closed.
 */
export async function editMessage(
  senderId: number,
  recipientId: number,
  messageId: number,
  body: string,
): Promise<Message> {
  const [res] = await pool.execute<ResultSetHeader>(
    `UPDATE messages SET body = ?, edited_at = NOW()
      WHERE id = ? AND sender_id = ? AND recipient_id = ?
        AND created_at >= NOW() - INTERVAL ${EDIT_WINDOW_MINUTES} MINUTE`,
    [body, messageId, senderId, recipientId],
  )
  const [rows] = await pool.execute<MessageRow[]>(
    `SELECT ${MESSAGE_COLS} FROM messages WHERE id = ? AND sender_id = ? AND recipient_id = ?`,
    [messageId, senderId, recipientId],
  )
  if (!rows[0]) throw new NotFoundError("Message")
  if (res.affectedRows === 0)
    throw new ForbiddenError(
      `You can only edit messages for ${EDIT_WINDOW_MINUTES} minutes after sending`,
      "EDIT_WINDOW_CLOSED",
    )
  return toMessage(rows[0], senderId)
}

/**
 * Deletes a message the sender wrote to the recipient.
 *
 * @throws NotFoundError when the sender wrote no such message to them.
 */
export async function deleteMessage(senderId: number, recipientId: number, messageId: number): Promise<void> {
  const [res] = await pool.execute<ResultSetHeader>(
    "DELETE FROM messages WHERE id = ? AND sender_id = ? AND recipient_id = ?",
    [messageId, senderId, recipientId],
  )
  if (res.affectedRows === 0) throw new NotFoundError("Message")
}
