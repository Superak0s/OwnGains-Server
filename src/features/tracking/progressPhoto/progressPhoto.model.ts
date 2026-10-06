// Progress photos: metadata in progress_photos, bytes in progress_photo_blobs.
//
// The split is the point. Every listing query used to read a table whose rows
// carried a LONGBLOB, so InnoDB dragged pages of image data through the buffer
// pool to return a date and an angle. The blob is now stored in its own table and
// is only touched by GET /:id/image.

import { createHash } from "node:crypto"
import sharp from "sharp"
import type { SharpOptions, Metadata } from "sharp"
import { pool, formatDateForMySQL, withTransaction } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { AppError, NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import { logger } from "@/utils/logger.js"

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
] as const
const MAX_PHOTO_SIZE = 10 * 1024 * 1024

// ─── Bounded decoding ─────────────────────────────────────────────────────────
//
// sharp's default pixel ceiling is ~268 MP, and a 10 MB single-colour PNG can
// declare enough of them to decode into a gigabyte of RGBA. 40 MP is a
// flagship phone sensor with room to spare. One libvips thread per decode and
// no operation cache: the box is small, the uploads are rare, and the libuv
// pool sharp runs on is shared with gzip, fs and DNS. Concurrency across
// requests is bounded separately by the decode slots in imageUpload.ts.
const MAX_INPUT_PIXELS = 40_000_000
sharp.concurrency(1)
sharp.cache(false)

const DECODE_OPTIONS = {
  limitInputPixels: MAX_INPUT_PIXELS,
  sequentialRead: true,
  failOn: "error",
} as const satisfies SharpOptions

/** Longest side of the stored original. */
const ORIGINAL_MAX_SIDE = 2048

// ─── Storage quota ────────────────────────────────────────────────────────────
//
// The only unbounded-growth path on the box: photo bytes live in a LONGBLOB, so
// when they fill the MySQL data directory *every* write on the instance starts
// failing, not just uploads, and InnoDB doesn't give the space back after a
// delete. Per user so one uploader can't starve the others. The instance-wide
// cap is the backstop for when there are many users (see .env.example).

/**
 * A size from the environment: unset or blank → the default, anything else must
 * be a finite number ≥ 0 or boot fails. `Number("abc")` is NaN and `NaN > 0` is
 * false, so a typo used to switch the quota off without a word.
 */
export function readSizeEnv(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return def
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`${name} must be a number ≥ 0 (0 disables it), got "${raw}"`)
  return n
}

/** Read at module load, so a bad value stops boot. Mutable for tests only. */
export const photoQuota = {
  /** Per-user cap in MB. 0 disables it. */
  perUserMb: readSizeEnv("PHOTO_QUOTA_MB", 1024),
  /** Instance-wide cap in GB across every user. 0 (the default) disables it. */
  totalGb: readSizeEnv("PHOTO_TOTAL_QUOTA_GB", 0),
}

const ALLOWED_ANGLES = ["front", "back", "side", "custom"] as const
const MAX_MUSCLE_NAME_LENGTH = 128

interface ProgressPhotoMeta extends RowDataPacket {
  id: number
  takenAt: string
  note: string | null
  angle: string
  customSideName: string | null
  createdAt: string
  /** JSON_ARRAYAGG, so the driver hands back a real array, or null for none. */
  muscleGroups: string[] | null
}

// The muscle groups come from a correlated subquery rather than a LEFT JOIN +
// GROUP BY: no grouping over the metadata columns, and an untagged photo comes
// back as NULL instead of a one-null array.
const SELECT_PHOTOS = `
  SELECT p.id, p.taken_at AS takenAt, p.note, p.angle,
         p.custom_side_name AS customSideName, p.created_at AS createdAt,
         (SELECT JSON_ARRAYAGG(m.muscle_group) FROM progress_photo_muscles m
           WHERE m.photo_id = p.id) AS muscleGroups
  FROM progress_photos p
`

/** The `uri` the app hands to <Image>, not a stored column. */
function withUri(row: ProgressPhotoMeta) {
  return {
    ...row,
    muscleGroups: row.muscleGroups ?? [],
    uri: `/api/tracking/photos/muscle/${row.id}/image`,
    thumbUri: `/api/tracking/photos/muscle/${row.id}/thumb`,
  }
}

/**
 * Read the header only and refuse anything over the pixel ceiling before a
 * single pixel is decoded. Throws ValidationError for undecodable input too.
 */
async function assertDecodable(photo: Buffer): Promise<void> {
  let meta: Metadata
  try {
    // Header only, so the pixel limit is lifted here: with it, sharp refuses
    // an oversized image with the same error as a corrupt one, and the caller
    // deserves to know which it sent.
    meta = await sharp(photo, { ...DECODE_OPTIONS, limitInputPixels: false }).metadata()
  } catch {
    throw new ValidationError("Invalid image data")
  }
  const { width, height } = meta
  if (!width || !height) throw new ValidationError("Invalid image data")
  if (width * height > MAX_INPUT_PIXELS)
    throw new ValidationError(
      `Image dimensions too large (max ${MAX_INPUT_PIXELS / 1_000_000} megapixels)`,
      null,
      "IMAGE_TOO_LARGE",
    )
}

/** Grid-tile JPEG: longest side 400px. rotate() bakes in the EXIF orientation the re-encode would otherwise drop. */
function makeThumb(photo: Buffer): Promise<Buffer> {
  return sharp(photo, DECODE_OPTIONS)
    .rotate()
    .resize(400, 400, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer()
}

/**
 * What gets stored: the upload re-encoded as a JPEG of at most 2048px a side,
 * with the orientation baked in and *no* metadata: the camera's EXIF includes
 * GPS coordinates, the device serial and the capture time, and the original
 * used to be served back verbatim. Also the real decode check: the magic-byte
 * sniff passes a truncated file.
 */
async function encodePhoto(photo: Buffer): Promise<{ original: Buffer; thumb: Buffer }> {
  await assertDecodable(photo)
  try {
    const original = await sharp(photo, DECODE_OPTIONS)
      .rotate()
      .resize(ORIGINAL_MAX_SIDE, ORIGINAL_MAX_SIDE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer()
    // From the re-encode, not the upload: already rotated and at most 4 MP.
    const thumb = await makeThumb(original)
    return { original, thumb }
  } catch {
    throw new ValidationError("Invalid image data")
  }
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex")

export async function uploadPhoto(
  userId: number,
  photoBuffer: Buffer,
  mimeType: string,
  meta: {
    muscleGroups: string[]
    note: string | null
    angle: string
    customSideName: string | null
    takenAt?: string | null
  },
): Promise<number> {
  const { muscleGroups, note, angle, customSideName, takenAt } = meta
  if (!Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0)
    throw new ValidationError("Invalid photo data")
  if (photoBuffer.length > MAX_PHOTO_SIZE)
    throw new ValidationError(
      `Photo size exceeds ${MAX_PHOTO_SIZE / (1024 * 1024)}MB limit`,
    )
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType))
    throw new ValidationError("Invalid image type. Allowed: JPEG, PNG, WebP")
  if (!(ALLOWED_ANGLES as readonly string[]).includes(angle))
    throw new ValidationError("Invalid angle")
  if (muscleGroups.length > 20)
    throw new ValidationError("Too many muscle groups")
  // A muscle group is a row now, not a piece of a comma-joined string, so a
  // comma in the name is just a character.
  if (muscleGroups.some((m) => typeof m !== "string" || !m || m.length > MAX_MUSCLE_NAME_LENGTH))
    throw new ValidationError("Invalid muscle group")

  const { original, thumb } = await encodePhoto(photoBuffer)

  return withTransaction(async (connection) => {
    // The quota check and the insert are one unit per user: the row lock makes
    // a second parallel upload wait for this one to commit and then count it,
    // where a SUM outside the transaction let N parallel uploads each overshoot.
    await connection.execute(`SELECT id FROM users WHERE id = ? FOR UPDATE`, [userId])
    if (photoQuota.perUserMb > 0) {
      const [[used]] = await connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(file_size), 0) AS bytes FROM progress_photos WHERE user_id = ?`,
        [userId],
      )
      if (Number(used.bytes) + original.length > photoQuota.perUserMb * 1024 * 1024)
        throw new ValidationError(
          `Photo storage quota reached (${photoQuota.perUserMb} MB). Delete older photos to upload more.`,
          null,
          "PHOTO_QUOTA_EXCEEDED",
        )
    }
    // Instance-wide backstop. Not serialised across users (that would be a
    // global lock), so it can overshoot by the uploads in flight, at most
    // MAX_CONCURRENT_DECODES re-encoded photos.
    if (photoQuota.totalGb > 0) {
      const [[total]] = await connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(file_size), 0) AS bytes FROM progress_photos`,
      )
      if (Number(total.bytes) + original.length > photoQuota.totalGb * 1024 ** 3) {
        logger.error(
          `Photo storage for the instance is full (PHOTO_TOTAL_QUOTA_GB=${photoQuota.totalGb}); uploads are refused until space is freed or the cap is raised`,
        )
        throw new AppError(
          "Photo storage on this server is full",
          507,
          null,
          "PHOTO_STORAGE_FULL",
        )
      }
    }

    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO progress_photos
         (user_id, mime_type, file_size, content_hash, taken_at, note, angle, custom_side_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        "image/jpeg",
        original.length,
        sha256(original),
        formatDateForMySQL(takenAt || new Date()),
        note ?? null,
        angle,
        customSideName ?? null,
      ],
    )
    const photoId = result.insertId

    await connection.execute(
      `INSERT INTO progress_photo_blobs (photo_id, data) VALUES (?, ?)`,
      [photoId, original],
    )
    await connection.execute(
      `INSERT INTO progress_photo_thumbs (photo_id, data) VALUES (?, ?)`,
      [photoId, thumb],
    )

    // At most 20 distinct groups. query() rather than execute() so the varying
    // row count doesn't create a prepared statement per count.
    const unique = [...new Set(muscleGroups)]
    await connection.query(
      `INSERT INTO progress_photo_muscles (photo_id, muscle_group) VALUES ?`,
      [unique.map((m) => [photoId, m])],
    )

    return photoId
  })
}

/**
 * One page, newest first. `before` is a MySQL DATETIME. `beforeId` breaks
 * ties on it (0 with only `before` = strictly older). Fetches one extra row
 * to learn whether another page exists.
 */
export async function getAllPhotos(
  userId: number,
  limit = 100,
  cursor?: { before: string; beforeId: number },
) {
  const [rows] = await pool.execute<ProgressPhotoMeta[]>(
    `${SELECT_PHOTOS} WHERE p.user_id = ?
     ${cursor ? "AND (p.taken_at < ? OR (p.taken_at = ? AND p.id < ?))" : ""}
     ORDER BY p.taken_at DESC, p.id DESC LIMIT ?`,
    cursor
      ? [userId, cursor.before, cursor.before, cursor.beforeId, limit + 1]
      : [userId, limit + 1],
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    data: page.map(withUri),
    nextCursor:
      rows.length > limit && last ? { before: last.takenAt, beforeId: String(last.id) } : null,
  }
}

export async function getPhotosByMuscle(
  userId: number,
  muscleGroup: string,
  limit = 100,
) {
  const [rows] = await pool.execute<ProgressPhotoMeta[]>(
    `${SELECT_PHOTOS}
     WHERE p.user_id = ? AND EXISTS (
       SELECT 1 FROM progress_photo_muscles m
        WHERE m.photo_id = p.id AND m.muscle_group = ?)
     ORDER BY p.taken_at DESC LIMIT ?`,
    [userId, muscleGroup, limit],
  )
  return rows.map(withUri)
}

/**
 * The stored content hash, without touching the blob: what lets a revalidation
 * (If-None-Match) be answered 304 from a metadata row. Null for a photo from
 * before hashes were stored until its first full read backfills it.
 */
export async function getPhotoHash(userId: number, photoId: number): Promise<string | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT content_hash AS hash FROM progress_photos WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Photo")
  return rows[0].hash
}

export async function getPhotoImage(
  userId: number,
  photoId: number,
): Promise<{ photoData: Buffer; mimeType: string; hash: string }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT b.data AS photoData, p.mime_type AS mimeType, p.content_hash AS hash
     FROM progress_photos p JOIN progress_photo_blobs b ON b.photo_id = p.id
     WHERE p.id = ? AND p.user_id = ?`,
    [photoId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Photo")
  let hash: string | null = rows[0].hash
  if (!hash) {
    hash = sha256(rows[0].photoData)
    await pool.execute(
      `UPDATE progress_photos SET content_hash = ? WHERE id = ? AND content_hash IS NULL`,
      [hash, photoId],
    )
  }
  return { photoData: rows[0].photoData, mimeType: rows[0].mimeType, hash }
}

/**
 * The stored thumbnail, or null for a photo uploaded before thumbnails existed
 * (the caller builds it with buildMissingThumb under a decode slot).
 */
export async function getPhotoThumb(userId: number, photoId: number): Promise<Buffer | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT t.data AS thumb FROM progress_photos p
     LEFT JOIN progress_photo_thumbs t ON t.photo_id = p.id
     WHERE p.id = ? AND p.user_id = ?`,
    [photoId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Photo")
  return rows[0].thumb ?? null
}

/** Build a pre-thumbnail photo's thumb once, with the same bounded decode as an upload, and keep it. */
export async function buildMissingThumb(userId: number, photoId: number): Promise<Buffer> {
  const { photoData } = await getPhotoImage(userId, photoId)
  await assertDecodable(photoData)
  const thumb = await makeThumb(photoData)
  await pool.execute(
    `INSERT IGNORE INTO progress_photo_thumbs (photo_id, data) VALUES (?, ?)`,
    [photoId, thumb],
  )
  return thumb
}

export async function deletePhoto(
  userId: number,
  photoId: number,
): Promise<boolean> {
  // The blob and the tags follow: both FKs are ON DELETE CASCADE.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM progress_photos WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Photo")
  return true
}
