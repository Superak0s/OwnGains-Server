import { pool, withTransaction } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { NotFoundError } from "@/middleware/errorHandler.js"
import { encodeAvatar, sha256 } from "@/features/tracking/progressPhoto/progressPhoto.model.js"
import { ARE_FRIENDS } from "@/features/social/friends/friends.model.js"

/** Replaces the user's profile photo. Returns the stored JPEG's hash. */
export async function setProfilePhoto(userId: number, upload: Buffer): Promise<string> {
  const jpeg = await encodeAvatar(upload)
  const hash = sha256(jpeg)
  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO profile_photos (user_id, content_hash) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE content_hash = VALUES(content_hash), updated_at = CURRENT_TIMESTAMP`,
      [userId, hash],
    )
    await conn.execute(
      `INSERT INTO profile_photo_blobs (user_id, data) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [userId, jpeg],
    )
  })
  return hash
}

type Photo = { data: Buffer; hash: string }

const PHOTO_SELECT = `SELECT b.data, p.content_hash AS hash
  FROM users u
  JOIN profile_photos p ON p.user_id = u.id
  JOIN profile_photo_blobs b ON b.user_id = u.id`

async function firstPhoto(where: string, params: (string | number)[]): Promise<Photo> {
  const [rows] = await pool.execute<RowDataPacket[]>(`${PHOTO_SELECT} WHERE ${where}`, params)
  if (!rows[0]) throw new NotFoundError("Profile photo")
  return { data: rows[0].data, hash: rows[0].hash }
}

/**
 * Loads a user's own profile photo.
 *
 * @param userId - Numeric id of the owner.
 */
export const getProfilePhoto = (userId: number) => firstPhoto("u.id = ?", [userId])

/** Only the owner and accepted friends can see a photo. Anyone else gets the same 404 as no photo. */
export const getVisibleProfilePhoto = (viewerId: number, userUuid: string) =>
  firstPhoto(
    `u.uuid = ? AND u.disabled_at IS NULL AND (u.id = ? OR ${ARE_FRIENDS})`,
    [userUuid, viewerId, viewerId, viewerId],
  )

/** Idempotent: removing a photo that isn't there is not an error. */
export async function deleteProfilePhoto(userId: number): Promise<void> {
  await pool.execute<ResultSetHeader>(`DELETE FROM profile_photos WHERE user_id = ?`, [userId])
}
