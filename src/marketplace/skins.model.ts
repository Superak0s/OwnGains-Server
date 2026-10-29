import { createHmac } from "node:crypto"
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise"
import { pool, parseMySQLDate, withTransaction } from "../config/database.js"
import { marketplaceConfig } from "./env.js"
import { skinColumns, type SkinDocument, type SkinUpload } from "./skinFormat.js"

export interface SkinSummary {
  id: number
  name: string
  description: string
  author: string | null
  version: number
  hasTheme: boolean
  hasBoards: boolean
  swatch: string[]
  downloads: number
  uniqueDownloads: number
  rating: { average: number | null; count: number }
  updatedAt: string
  /** Set only in the author's own list, on a skin the operator removed. */
  takenDown: { reason: string } | null
}

export interface SkinDetail extends SkinSummary {
  skin: SkinDocument
  myRating: number | null
  url: string
  mine: boolean
}

export type SkinSort = "popular" | "rating" | "new"

export const PAGE_SIZE = 20

const SUMMARY_COLUMNS =
  "id, name, description, author_name, version, has_theme, has_boards, swatch, downloads, unique_downloads, rating_sum, rating_count, updated_at, taken_down_at, taken_down_reason"

const ORDER: Record<SkinSort, string> = {
  popular: "unique_downloads DESC, id DESC",
  rating: "rating_sum / NULLIF(rating_count, 0) IS NULL, rating_sum / NULLIF(rating_count, 0) DESC, rating_count DESC, id DESC",
  new: "id DESC",
}

export const skinUrl = (id: number) => `${marketplaceConfig.publicUrl}/skins/${id}`

const averageOf = (sum: number, count: number) => (count ? Math.round((sum / count) * 10) / 10 : null)

function toSummary(r: RowDataPacket): SkinSummary {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    author: r.author_name,
    version: r.version,
    hasTheme: !!r.has_theme,
    hasBoards: !!r.has_boards,
    swatch: JSON.parse(r.swatch),
    downloads: r.downloads,
    uniqueDownloads: r.unique_downloads,
    rating: { average: averageOf(r.rating_sum, r.rating_count), count: r.rating_count },
    updatedAt: parseMySQLDate(r.updated_at).toISOString(),
    takenDown: r.taken_down_at ? { reason: r.taken_down_reason ?? "Removed by the marketplace operator" } : null,
  }
}

/** Demo skins (filled by the server's demo data) are seen only by their owner. Takes the viewer's uuid or null. */
const VISIBLE_TO = "(demo_for IS NULL OR demo_for = ?)"

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export async function listSkins(opts: {
  q?: string
  sort: SkinSort
  page: number
  authorUuid?: string
  viewerUuid?: string
}): Promise<{ skins: SkinSummary[]; page: number; hasMore: boolean }> {
  // The author still sees a removed skin, with the reason.
  const where = [opts.authorUuid ? "TRUE" : "taken_down_at IS NULL", VISIBLE_TO]
  const params: (string | number | null)[] = [opts.viewerUuid ?? null]
  if (opts.q) {
    where.push("name LIKE ?")
    params.push(`%${escapeLike(opts.q)}%`)
  }
  if (opts.authorUuid) {
    where.push("author_uuid = ?")
    params.push(opts.authorUuid)
  }
  // LIMIT/OFFSET are integers we computed, inlined because mysql2 prepared statements reject them as strings.
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT ${SUMMARY_COLUMNS} FROM skins WHERE ${where.join(" AND ")} ORDER BY ${ORDER[opts.sort]} LIMIT ${PAGE_SIZE + 1} OFFSET ${(opts.page - 1) * PAGE_SIZE}`,
    params,
  )
  return { skins: rows.slice(0, PAGE_SIZE).map(toSummary), page: opts.page, hasMore: rows.length > PAGE_SIZE }
}

/** A skin visible to `viewerUuid` (not taken down, and not someone else's demo skin), or null. */
export async function findSkin(
  id: number,
  viewerUuid?: string,
): Promise<(SkinSummary & { skin: SkinDocument; authorUuid: string | null }) | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT ${SUMMARY_COLUMNS}, body, author_uuid FROM skins WHERE id = ? AND taken_down_at IS NULL AND ${VISIBLE_TO}`,
    [id, viewerUuid ?? null],
  )
  if (!rows[0]) return null
  return { ...toSummary(rows[0]), skin: JSON.parse(rows[0].body), authorUuid: rows[0].author_uuid }
}

/** The account's id under the server's secret. It stays unique per account but names nobody once the account is gone. */
const accountKey = (uuid: string) => createHmac("sha256", marketplaceConfig.downloadSalt).update(`account:${uuid}`).digest()

export async function findRating(skinId: number, uuid: string): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT stars FROM skin_ratings WHERE skin_id = ? AND rater_key = ?",
    [skinId, accountKey(uuid)],
  )
  return rows[0]?.stars ?? null
}

const contentColumns = ({ name, description, skin }: SkinUpload) => [name, description, ...skinColumns(skin)]

export async function createSkin(upload: SkinUpload, author: { uuid: string; username: string }): Promise<number> {
  const [res] = await pool.execute<ResultSetHeader>(
    "INSERT INTO skins (name, description, body, has_theme, has_boards, swatch, author_uuid, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [...contentColumns(upload), author.uuid, author.username],
  )
  return res.insertId
}

/** Replaces a skin's content and bumps its version. Counts and ratings stay. */
export async function updateSkin(id: number, upload: SkinUpload): Promise<number> {
  await pool.execute(
    "UPDATE skins SET name = ?, description = ?, body = ?, has_theme = ?, has_boards = ?, swatch = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [...contentColumns(upload), id],
  )
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT version FROM skins WHERE id = ?", [id])
  return rows[0].version
}

/** Deletes the skin if `authorUuid` published it, taken down or not. False when it did not. */
export async function deleteOwnSkin(id: number, authorUuid: string): Promise<boolean> {
  const [res] = await pool.execute<ResultSetHeader>("DELETE FROM skins WHERE id = ? AND author_uuid = ?", [id, authorUuid])
  return res.affectedRows > 0
}

export async function takeDownSkin(id: number, reason: string): Promise<void> {
  await pool.execute("UPDATE skins SET taken_down_at = UTC_TIMESTAMP(), taken_down_reason = ? WHERE id = ?", [reason, id])
}

/** Counts a download, and a unique one the first time this install fetches this skin. Null when the skin is not visible. */
export async function recordDownload(
  id: number,
  installId: string | null,
  viewerUuid?: string,
): Promise<{ downloads: number; uniqueDownloads: number } | null> {
  return withTransaction(async (conn) => {
    const [res] = await conn.execute<ResultSetHeader>(
      `UPDATE skins SET downloads = downloads + 1 WHERE id = ? AND taken_down_at IS NULL AND ${VISIBLE_TO}`,
      [id, viewerUuid ?? null],
    )
    if (!res.affectedRows) return null
    if (installId) {
      const hash = createHmac("sha256", marketplaceConfig.downloadSalt).update(`${id}:${installId}`).digest()
      const [ins] = await conn.execute<ResultSetHeader>("INSERT IGNORE INTO skin_downloads (skin_id, hash) VALUES (?, ?)", [id, hash])
      if (ins.affectedRows === 1) await conn.execute("UPDATE skins SET unique_downloads = unique_downloads + 1 WHERE id = ?", [id])
    }
    const [rows] = await conn.execute<RowDataPacket[]>("SELECT downloads, unique_downloads FROM skins WHERE id = ?", [id])
    return { downloads: rows[0].downloads, uniqueDownloads: rows[0].unique_downloads }
  })
}

export async function rateSkin(id: number, uuid: string, stars: number): Promise<{ average: number | null; count: number; myRating: number }> {
  return withTransaction(async (conn) => {
    await conn.execute(
      "INSERT INTO skin_ratings (skin_id, rater_key, stars) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE stars = VALUES(stars)",
      [id, accountKey(uuid), stars],
    )
    await conn.execute(
      `UPDATE skins s JOIN (SELECT COALESCE(SUM(stars), 0) AS total, COUNT(*) AS n FROM skin_ratings WHERE skin_id = ?) r
        SET s.rating_sum = r.total, s.rating_count = r.n WHERE s.id = ?`,
      [id, id],
    )
    const [rows] = await conn.execute<RowDataPacket[]>("SELECT rating_sum, rating_count FROM skins WHERE id = ?", [id])
    return { average: averageOf(rows[0].rating_sum, rows[0].rating_count), count: rows[0].rating_count, myRating: stars }
  })
}

export async function addReport(id: number, uuid: string, reason: string): Promise<void> {
  await pool.execute(
    "INSERT INTO skin_reports (skin_id, reporter_key, reason) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)",
    [id, accountKey(uuid), reason],
  )
}

/** Removes users' names and ids from their skins, which stay published. Ratings and reports only ever hold the account key. */
export async function anonymizeUsers(uuids: string[], conn: Pool | PoolConnection = pool): Promise<void> {
  if (!uuids.length) return
  await conn.query("UPDATE skins SET author_uuid = NULL, author_name = NULL WHERE author_uuid IN (?)", [uuids])
}
