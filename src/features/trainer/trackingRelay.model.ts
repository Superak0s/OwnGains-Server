// The Tracking Access mailbox. A client's app encrypts its tracking data to each
// of its trainer's device keys and the server only stores and hands over the
// ciphertext. Nothing here can read a payload, and nothing logs one.
import { pool, parseMySQLDate, withTransaction } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { AppError, NotFoundError } from "@/middleware/errorHandler.js"

/** Largest single message, as base64 ciphertext. A compressed progress photo fits. */
export const MAX_MESSAGE_CHARS = 3 * 1024 * 1024
/** Undelivered ciphertext one grant may hold across all trainer devices. */
const MAX_PENDING_CHARS_PER_GRANT = 50 * 1024 * 1024
/** Device keys one trainer may hold. Registering another drops the oldest. */
const MAX_DEVICES_PER_TRAINER = 5
const MESSAGE_TTL_DAYS = 30

export type MessageKind = "snapshot" | "photo"

/** One trainer device a client must encrypt to. */
export interface RecipientKey {
  keyId: number
  publicKey: string
  /** The device asked for everything again. Cleared by the next snapshot sent to it. */
  resend: boolean
}

export interface Recipient {
  trainerId: string
  keys: RecipientKey[]
}

export interface OutgoingMessage {
  keyId: number
  kind: MessageKind
  ref: string
  nonce: string
  senderKey: string
  ciphertext: string
}

export interface PendingMessage {
  id: string
  clientId: string
  kind: MessageKind
  ref: string
  nonce: string
  senderKey: string
  ciphertext: string
  createdAt: string
}

/**
 * Registers the caller's device key, or returns the existing row when the key
 * is unchanged. A new key for a known device replaces the row, which drops what
 * was encrypted to the old key, so clients see a new `keyId` and send it all again.
 *
 * @returns The key's id.
 */
export async function registerDeviceKey(
  userId: number,
  deviceId: string,
  publicKey: string,
): Promise<number> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<(RowDataPacket & { id: number; publicKey: string })[]>(
      `SELECT id, public_key AS publicKey FROM trainer_device_keys
       WHERE user_id = ? AND device_id = ? FOR UPDATE`,
      [userId, deviceId],
    )
    if (rows[0]?.publicKey === publicKey) return rows[0].id
    if (rows[0]) await conn.execute(`DELETE FROM trainer_device_keys WHERE id = ?`, [rows[0].id])

    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO trainer_device_keys (user_id, device_id, public_key) VALUES (?, ?, ?)`,
      [userId, deviceId, publicKey],
    )
    // A reinstall gets a fresh device id, so old installs would pile up and
    // every client would keep encrypting to them.
    const [stale] = await conn.execute<(RowDataPacket & { id: number })[]>(
      `SELECT id FROM trainer_device_keys WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET ${MAX_DEVICES_PER_TRAINER}`,
      [userId],
    )
    for (const { id } of stale) await conn.execute(`DELETE FROM trainer_device_keys WHERE id = ?`, [id])
    return result.insertId
  })
}

/** Every trainer the caller granted Tracking Access, with their device keys. */
export async function getRecipients(clientId: number): Promise<Recipient[]> {
  const [rows] = await pool.execute<
    (RowDataPacket & { trainerId: string; keyId: number | null; publicKey: string | null; resend: number })[]
  >(
    `SELECT u.uuid AS trainerId, k.id AS keyId, k.public_key AS publicKey,
       EXISTS (SELECT 1 FROM tracking_resend_requests r
         WHERE r.permission_id = sp.id AND r.device_key_id = k.id) AS resend
     FROM sharing_permissions sp
     JOIN users u ON u.id = sp.to_user_id
     LEFT JOIN trainer_device_keys k ON k.user_id = sp.to_user_id
     WHERE sp.from_user_id = ? AND sp.permission_type = 'tracking'
     ORDER BY u.uuid, k.id`,
    [clientId],
  )
  const byTrainer = new Map<string, Recipient>()
  for (const r of rows) {
    const recipient = byTrainer.get(r.trainerId) ?? { trainerId: r.trainerId, keys: [] }
    byTrainer.set(r.trainerId, recipient)
    if (r.keyId != null && r.publicKey)
      recipient.keys.push({ keyId: r.keyId, publicKey: r.publicKey, resend: !!Number(r.resend) })
  }
  return [...byTrainer.values()]
}

/**
 * Stores one message from a client to one trainer device, replacing whatever
 * was pending in the same slot. A snapshot also clears that device's resend
 * request, because clients send photos first and the snapshot last.
 *
 * @throws NotFoundError when the key isn't one of a trainer the caller granted Tracking Access.
 * @throws AppError 413 when the grant already holds too much undelivered data.
 */
export async function storeMessage(clientId: number, m: OutgoingMessage): Promise<void> {
  await withTransaction(async (conn) => {
    const [grants] = await conn.execute<(RowDataPacket & { permissionId: number })[]>(
      `SELECT sp.id AS permissionId FROM trainer_device_keys k
       JOIN sharing_permissions sp ON sp.to_user_id = k.user_id
        AND sp.from_user_id = ? AND sp.permission_type = 'tracking'
       WHERE k.id = ? FOR UPDATE`,
      [clientId, m.keyId],
    )
    const permissionId = grants[0]?.permissionId
    if (!permissionId) throw new NotFoundError("Trainer device")

    // A replaced slot was already counted once, so it doesn't count twice.
    const [[pending]] = await conn.execute<(RowDataPacket & { n: number | null })[]>(
      `SELECT SUM(CHAR_LENGTH(ciphertext)) AS n FROM tracking_messages
       WHERE permission_id = ? AND NOT (device_key_id = ? AND kind = ? AND ref = ?)`,
      [permissionId, m.keyId, m.kind, m.ref],
    )
    if (Number(pending.n ?? 0) + m.ciphertext.length > MAX_PENDING_CHARS_PER_GRANT)
      throw new AppError(
        "Your trainer has too much undelivered tracking data. It is sent once their phone collects it",
        413,
        null,
        "MAILBOX_FULL",
      )

    // Delete and insert rather than update in place: a trainer device that
    // fetched the old row and acks its id must not delete the newer content.
    await conn.execute(
      `DELETE FROM tracking_messages
       WHERE permission_id = ? AND device_key_id = ? AND kind = ? AND ref = ?`,
      [permissionId, m.keyId, m.kind, m.ref],
    )
    await conn.execute(
      `INSERT INTO tracking_messages
         (permission_id, device_key_id, kind, ref, nonce, sender_key, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [permissionId, m.keyId, m.kind, m.ref, m.nonce, m.senderKey, m.ciphertext],
    )
    if (m.kind === "snapshot")
      await conn.execute(
        `DELETE FROM tracking_resend_requests WHERE permission_id = ? AND device_key_id = ?`,
        [permissionId, m.keyId],
      )
  })
}

/** The oldest pending messages for one of the caller's devices. */
export async function getPendingMessages(
  trainerId: number,
  deviceId: string,
  limit: number,
): Promise<PendingMessage[]> {
  const [rows] = await pool.execute<
    (RowDataPacket & Omit<PendingMessage, "id" | "createdAt"> & { id: number; createdAt: string })[]
  >(
    `SELECT m.id, u.uuid AS clientId, m.kind, m.ref, m.nonce, m.sender_key AS senderKey,
       m.ciphertext, m.created_at AS createdAt
     FROM tracking_messages m
     JOIN trainer_device_keys k ON k.id = m.device_key_id
     JOIN sharing_permissions sp ON sp.id = m.permission_id
     JOIN users u ON u.id = sp.from_user_id
     WHERE k.user_id = ? AND k.device_id = ?
     ORDER BY m.id LIMIT ${Math.trunc(limit)}`,
    [trainerId, deviceId],
  )
  return rows.map((r) => ({
    ...r,
    id: String(r.id),
    createdAt: parseMySQLDate(r.createdAt).toISOString(),
  }))
}

/** Deletes messages the caller's device has received. Ids that aren't its own are ignored. */
export async function ackMessages(trainerId: number, deviceId: string, ids: number[]): Promise<void> {
  if (ids.length === 0) return
  await pool.execute(
    `DELETE m FROM tracking_messages m
     JOIN trainer_device_keys k ON k.id = m.device_key_id
     WHERE k.user_id = ? AND k.device_id = ? AND m.id IN (${ids.map(() => "?").join(",")})`,
    [trainerId, deviceId, ...ids],
  )
}

/**
 * Asks a client to send everything to one of the caller's devices again.
 *
 * @throws NotFoundError when the device isn't registered or the client hasn't granted Tracking Access.
 */
export async function requestResend(trainerId: number, deviceId: string, clientUuid: string): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT IGNORE INTO tracking_resend_requests (permission_id, device_key_id)
     SELECT sp.id, k.id FROM trainer_device_keys k
     JOIN sharing_permissions sp ON sp.to_user_id = k.user_id AND sp.permission_type = 'tracking'
     JOIN users u ON u.id = sp.from_user_id AND u.uuid = ?
     WHERE k.user_id = ? AND k.device_id = ?`,
    [clientUuid, trainerId, deviceId],
  )
  if (result.affectedRows === 0) {
    // INSERT IGNORE also reports 0 for a request that is already pending.
    const [exists] = await pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM trainer_device_keys k
       JOIN sharing_permissions sp ON sp.to_user_id = k.user_id AND sp.permission_type = 'tracking'
       JOIN users u ON u.id = sp.from_user_id AND u.uuid = ?
       WHERE k.user_id = ? AND k.device_id = ?`,
      [clientUuid, trainerId, deviceId],
    )
    if (!exists.length) throw new NotFoundError("Tracking Access")
  }
}

/** Deletes undelivered ciphertext older than 30 days. */
export async function purgeExpiredTrackingMessages(): Promise<void> {
  await pool.execute(
    `DELETE FROM tracking_messages WHERE created_at < NOW() - INTERVAL ${MESSAGE_TTL_DAYS} DAY`,
  )
}
