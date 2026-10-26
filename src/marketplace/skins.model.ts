import type { RowDataPacket, ResultSetHeader } from "mysql2/promise"
import { pool, parseMySQLDate } from "../config/database.js"
import { marketplaceConfig } from "./env.js"
import { swatchOf, type SkinDocument, type SkinUpload } from "./skinFormat.js"

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
  "id, name, description, author_name, version, has_theme, has_boards, swatch, downloads, unique_downloads, rating_sum, rating_count, updated_at"

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
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export async function listSkins(opts: {
  q?: string
  sort: SkinSort
  page: number
  authorUuid?: string
}): Promise<{ skins: SkinSummary[]; page: number; hasMore: boolean }> {
  const where = ["taken_down_at IS NULL"]
  const params: (string | number)[] = []
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

/** A visible (not taken down) skin, or null. */
export async function findSkin(id: number): Promise<(SkinSummary & { skin: SkinDocument; authorUuid: string | null }) | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT ${SUMMARY_COLUMNS}, body, author_uuid FROM skins WHERE id = ? AND taken_down_at IS NULL`,
    [id],
  )
  if (!rows[0]) return null
  return { ...toSummary(rows[0]), skin: JSON.parse(rows[0].body), authorUuid: rows[0].author_uuid }
}

export async function findRating(skinId: number, uuid: string): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT stars FROM skin_ratings WHERE skin_id = ? AND rater_uuid = ?",
    [skinId, uuid],
  )
  return rows[0]?.stars ?? null
}

const contentColumns = ({ name, description, skin }: SkinUpload) => [
  name,
  description,
  JSON.stringify(skin),
  !!skin.theme,
  !!skin.boards && Object.keys(skin.boards).length > 0,
  JSON.stringify(swatchOf(skin)),
]

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
    "UPDATE skins SET name = ?, description = ?, body = ?, has_theme = ?, has_boards = ?, swatch = ?, version = version + 1 WHERE id = ?",
    [...contentColumns(upload), id],
  )
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT version FROM skins WHERE id = ?", [id])
  return rows[0].version
}

export async function deleteSkin(id: number): Promise<void> {
  await pool.execute("DELETE FROM skins WHERE id = ?", [id])
}

export async function takeDownSkin(id: number): Promise<void> {
  await pool.execute("UPDATE skins SET taken_down_at = UTC_TIMESTAMP() WHERE id = ?", [id])
}
