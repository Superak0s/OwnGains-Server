import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { pool } from "@/config/database.js"
import { envBool } from "@/config/env.js"

/**
 * Off by default: the `feedback` table is not in schema.sql, so only an instance
 * whose operator created it by hand (the official server) mounts these routes.
 */
export const feedbackEnabled = envBool("FEEDBACK_ENABLED", false)

/** The privacy policy promises feedback is deleted a year after it was sent. */
const FEEDBACK_RETENTION_DAYS = 365

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const
export const FEEDBACK_STATUSES = ["new", "read", "done"] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export interface NewFeedback {
  kind: FeedbackKind
  message: string
  contact: string | null
  appVersion: string | null
  platform: string | null
  osVersion: string | null
  userId: number | null
}

interface FeedbackRow extends RowDataPacket {
  id: number
  kind: FeedbackKind
  message: string
  contact: string | null
  app_version: string | null
  platform: string | null
  os_version: string | null
  status: FeedbackStatus
  created_at: Date
  user_uuid: string | null
  username: string | null
}

export async function insertFeedback(f: NewFeedback): Promise<void> {
  await pool.execute(
    `INSERT INTO feedback (kind, message, contact, app_version, platform, os_version, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [f.kind, f.message, f.contact, f.appVersion, f.platform, f.osVersion, f.userId],
  )
}

export async function listFeedback(status: FeedbackStatus | null, limit: number) {
  const [rows] = await pool.execute<FeedbackRow[]>(
    `SELECT f.id, f.kind, f.message, f.contact, f.app_version, f.platform, f.os_version,
            f.status, f.created_at, u.uuid AS user_uuid, u.username
     FROM feedback f LEFT JOIN users u ON u.id = f.user_id
     WHERE (? IS NULL OR f.status = ?)
     ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
    [status, status, limit],
  )
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    message: r.message,
    contact: r.contact,
    appVersion: r.app_version,
    platform: r.platform,
    osVersion: r.os_version,
    status: r.status,
    createdAt: r.created_at,
    user: r.user_uuid ? { id: r.user_uuid, username: r.username } : null,
  }))
}

export async function setFeedbackStatus(id: number, status: FeedbackStatus): Promise<boolean> {
  const [res] = await pool.execute<ResultSetHeader>("UPDATE feedback SET status = ? WHERE id = ?", [
    status,
    id,
  ])
  return res.affectedRows > 0
}

export async function deleteFeedback(id: number): Promise<boolean> {
  const [res] = await pool.execute<ResultSetHeader>("DELETE FROM feedback WHERE id = ?", [id])
  return res.affectedRows > 0
}

export async function purgeOldFeedback(batch = 5000): Promise<number> {
  const [res] = await pool.execute<ResultSetHeader>(
    `DELETE FROM feedback WHERE created_at < NOW() - INTERVAL ${FEEDBACK_RETENTION_DAYS} DAY LIMIT ${batch | 0}`,
  )
  return res.affectedRows
}
