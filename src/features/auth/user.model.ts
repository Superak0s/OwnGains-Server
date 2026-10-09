import { pool, withTransaction } from "@/config/database.js"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import type { UserBodyData } from "./user.types.js"
import { asDuplicateUserError } from "./auth.model.js"

const ALLOWED_FIELDS = [
  "name",
  "email",
  "bf_formula_sex",
  "height_cm",
  "height_unit",
  "weight_unit",
] as const
type ProfileField = (typeof ALLOWED_FIELDS)[number]

export async function updateUserProfile(
  userId: number,
  updates: Partial<Record<ProfileField, unknown>>,
): Promise<boolean> {
  const fields: string[] = []
  const values: unknown[] = []

  for (const key of ALLOWED_FIELDS) {
    if (updates[key] === undefined) continue

    // ck_users_height only rejects <= 0. The 300 cm ceiling is enforced here
    // alone, and this also gets the user a readable message.
    if (key === "height_cm") {
      const h = Number(updates[key])
      if (!Number.isFinite(h) || h <= 0 || h > 300)
        throw new ValidationError("Height must be between 1-300 cm")
    }

    // ENUM would catch this as a 500. A readable 400 is the point of the loop.
    if (
      key === "bf_formula_sex" &&
      updates[key] !== null &&
      updates[key] !== "male" &&
      updates[key] !== "female"
    )
      throw new ValidationError("bf_formula_sex must be 'male' or 'female'")

    fields.push(`${key} = ?`)
    values.push(updates[key])
  }

  if (fields.length === 0)
    throw new ValidationError("No valid fields to update")
  values.push(userId)
  // uq_users_email rejects a taken address, so no pre-check SELECT is needed.
  try {
    await pool.execute(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      values as (string | number | null)[],
    )
  } catch (err) {
    throw asDuplicateUserError(err)
  }
  return true
}

export async function getUserBodyData(userId: number): Promise<UserBodyData> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT height_cm, bf_formula_sex, weight_unit FROM users WHERE id = ?`,
    [userId],
  )
  if (!rows[0]) throw new NotFoundError("User")
  return {
    // decimalNumbers on the pool: height_cm is already a number here.
    heightCm: rows[0].height_cm,
    bfFormulaSex: rows[0].bf_formula_sex || "male",
    weightUnit: rows[0].weight_unit,
  }
}

/**
 * Every table that references `users`, and the column(s) it does it through,
 * read from the live schema instead of a hand-kept list.
 *
 * The hand-kept list was wrong: it named tables that no longer exist and had
 * never gained `user_blocks` or `user_reports`, so "wipe all my data" quietly
 * left those behind. A new table gets picked up here the moment it declares its
 * foreign key, which is the only way this remains correct.
 *
 * `refresh_tokens` is excluded deliberately: those are auth state, not user
 * data. Wiping them would log the caller out of the very request doing the
 * wiping, and their hashes have no business in a data export.
 */
const EXCLUDED_TABLES = new Set(["refresh_tokens"])

// Columns holding a users.id with no FK to declare it, so the schema walk
// can't see them. idempotency_keys.actor_id is the acting trainer (0 = the
// owner), and without this the trainee's export carried the trainer's
// internal id.
const UNDECLARED_USER_COLUMNS: Record<string, string[]> = {
  idempotency_keys: ["actor_id"],
}

// user_blocks and user_reports point at users in BOTH directions (I block you
// / you block me). Following every FK column would delete and export the other
// direction too: "Clear All Data" erasing the blocks and reports filed
// AGAINST the caller. Only the column meaning "this user authored the row"
// counts as owned data.
const OUTBOUND_ONLY: Record<string, string> = {
  user_blocks: "blocker_id",
  user_reports: "reporter_id",
  // A cooldown protects the recipient from the requester. The requester
  // clearing their data must not lift it, but the recipient clearing theirs may.
  friend_request_cooldowns: "recipient_id",
}

/**
 * Tables "Clear All Data" detaches the caller from instead of deleting.
 * A report the user filed is the moderator's record, not the reporter's data:
 * deleting the account already keeps it (reporter_id is ON DELETE SET NULL),
 * and letting a wipe erase it let someone file reports and then take them
 * back unseen. The export still includes them.
 */
const WIPE_ANONYMISES: Record<string, string> = {
  user_reports: "reporter_id",
}

interface UserTables {
  /** table -> the column(s) meaning "this user's row" (see OUTBOUND_ONLY). */
  owned: Map<string, string[]>
  /** table -> EVERY column that references users.id, owned or not. */
  userColumns: Map<string, string[]>
  /**
   * Tables with no FK to `users` of their own, reached through a parent that
   * has one (workout_sets through workouts, program_exercises through
   * program_days and programs), each with the SELECT that exports them.
   */
  children: Map<string, ChildExport>
}

interface ChildExport {
  /** `SELECT c.* FROM … WHERE <root ownership>`, one `?` per userId. */
  sql: string
  params: number
}

/**
 * Child tables the export leaves out: image bytes. The metadata row in
 * progress_photos (and its muscle tags) is exported. The JPEGs are fetched
 * through the photo routes, and inlining them would put megabytes of base64
 * per photo into one JSON response on a small box.
 */
const EXPORT_SKIPPED_CHILDREN = new Set([
  "progress_photo_blobs",
  "progress_photo_thumbs",
])

interface ForeignKeyRow {
  tableName: string
  constraintName: string
  columnName: string
  refTable: string
  refColumn: string
}

/**
 * Walk the FK graph down from the tables that reference a user directly. The first
 * version of the export only read tables with an FK to `users`, which left out
 * every workout set, program day and exercise, supplement dose, soreness
 * follow-up and photo tag, all of them keyed by their parent, not the user.
 * Each child joins up its chain to an owned root, so a row is only exported
 * when that root row is the caller's.
 */
function buildChildExports(
  fks: ForeignKeyRow[],
  owned: Map<string, string[]>,
  userColumns: Map<string, string[]>,
): Map<string, ChildExport> {
  // table -> constraint -> its column pairs, in key order.
  const byTable = new Map<string, Map<string, ForeignKeyRow[]>>()
  for (const fk of fks) {
    if (fk.refTable === "users" || fk.refTable === fk.tableName) continue
    const cons = byTable.get(fk.tableName) ?? new Map<string, ForeignKeyRow[]>()
    cons.set(fk.constraintName, [...(cons.get(fk.constraintName) ?? []), fk])
    byTable.set(fk.tableName, cons)
  }

  // Each reached table's path up to its root: the FK column pairs of every
  // hop, child first. A root is an owned table whose ownership is one column
  // the user authored, never a two-sided table like friendships, whose
  // "children" would include the other person's rows.
  const paths = new Map<string, { hops: ForeignKeyRow[][]; rootWhere: string }>()
  for (const [table, cols] of owned) {
    if (cols.length !== 1 || OUTBOUND_ONLY[table]) continue
    paths.set(table, { hops: [], rootWhere: cols[0] })
  }

  const children = new Map<string, ChildExport>()
  let grew = true
  while (grew) {
    grew = false
    for (const [table, cons] of byTable) {
      if (paths.has(table) || owned.has(table) || EXPORT_SKIPPED_CHILDREN.has(table))
        continue
      const hop = [...cons.values()].find((cols) => paths.has(cols[0].refTable))
      /* v8 ignore next -- the current schema declares every child table after its parent */
      if (!hop) continue
      addChildExport(table, hop, paths, children, userColumns)
      grew = true
    }
  }
  return children
}

function addChildExport(
  table: string,
  hop: ForeignKeyRow[],
  paths: Map<string, { hops: ForeignKeyRow[][]; rootWhere: string }>,
  children: Map<string, ChildExport>,
  userColumns: Map<string, string[]>,
): void {
  const up = paths.get(hop[0].refTable)!
  const hops = [hop, ...up.hops]
  paths.set(table, { hops, rootWhere: up.rootWhere })

  // t0 is the child, and t1…tN walk up to the root.
  const joins = hops.map((cols, i) => {
    const on = cols
      .map((c) => `t${i + 1}.${c.refColumn} = t${i}.${c.columnName}`)
      .join(" AND ")
    return `JOIN ${cols[0].refTable} t${i + 1} ON ${on}`
  })
  children.set(table, {
    sql: `SELECT t0.* FROM ${table} t0 ${joins.join(" ")}
          WHERE t${hops.length}.${up.rootWhere} = ?`,
    params: 1,
  })

  // A composite FK through the parent's user column (supplement_intake's
  // (user_id, supplement_id)) carries a numeric users.id. Mark it so
  // idsToUuids rewrites it like any other.
  const parentUserCols = userColumns.get(hop[0].refTable) ?? []
  const childUserCols = hop
    .filter((c) => parentUserCols.includes(c.refColumn))
    .map((c) => c.columnName)
  if (childUserCols.length) userColumns.set(table, childUserCols)
}

let userTables: Promise<UserTables> | null = null

function getUserOwnedTables(): Promise<Map<string, string[]>> {
  return getUserTables().then((t) => t.owned)
}

function getUserTables(): Promise<UserTables> {
  userTables ??= (async () => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE()
         AND REFERENCED_TABLE_NAME = 'users'
         AND REFERENCED_COLUMN_NAME = 'id'
       ORDER BY TABLE_NAME, COLUMN_NAME`,
    )
    const [fkRows] = await pool.execute<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
              COLUMN_NAME AS columnName, REFERENCED_TABLE_NAME AS refTable,
              REFERENCED_COLUMN_NAME AS refColumn
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    )
    const owned = new Map<string, string[]>()
    const userColumns = new Map<string, string[]>()
    for (const r of rows) {
      const table = String(r.tableName)
      if (EXCLUDED_TABLES.has(table)) continue
      userColumns.set(table, [...(userColumns.get(table) ?? []), String(r.columnName)])
      const outbound = OUTBOUND_ONLY[table]
      if (outbound) {
        owned.set(table, [outbound])
        continue
      }
      owned.set(table, [...(owned.get(table) ?? []), String(r.columnName)])
    }
    for (const [table, cols] of Object.entries(UNDECLARED_USER_COLUMNS))
      userColumns.set(table, cols) // Undeclared, so never already in the map.
    const children = buildChildExports(
      fkRows as ForeignKeyRow[],
      owned,
      userColumns,
    )
    return { owned, userColumns, children }
  })()
  return userTables
}

/**
 * Rewrite every users.id-valued column in the exported rows to that user's
 * uuid. The raw rows had numeric ids (the caller's own and, through
 * friend_id / requested_by / to_user_id / blocked_id / reported_id, other
 * people's), and the numeric id is never meant to leave the server. An id
 * with no user behind it any more becomes null.
 */
async function idsToUuids(
  data: Record<string, unknown>,
  userColumns: Map<string, string[]>,
): Promise<void> {
  const ids = new Set<number>()
  forEachUserCell(data, userColumns, (row, c) => {
    if (typeof row[c] === "number") ids.add(row[c])
  })
  const uuidById = new Map<number, string>()
  const all = [...ids]
  for (let i = 0; i < all.length; i += 1000) {
    const chunk = all.slice(i, i + 1000)
    const [rows] = await pool.execute<(RowDataPacket & { id: number; uuid: string })[]>(
      `SELECT id, uuid FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    )
    for (const r of rows) uuidById.set(r.id, r.uuid)
  }
  forEachUserCell(data, userColumns, (row, c) => {
    /* v8 ignore next -- the "?? null" is for a user deleted between the two reads */
    if (row[c] != null) row[c] = uuidById.get(row[c]) ?? null
  })
}

function forEachUserCell(
  data: Record<string, unknown>,
  userColumns: Map<string, string[]>,
  fn: (row: RowDataPacket, column: string) => void,
): void {
  for (const [table, cols] of userColumns)
    for (const row of (data[table] as RowDataPacket[] | undefined) ?? [])
      for (const c of cols) fn(row, c)
}

/** `user_id = ? OR friend_id = ?`: every way this table can point at a user. */
function ownershipClause(columns: string[]): string {
  return columns.map((c) => `${c} = ?`).join(" OR ")
}

/**
 * Per-table ceiling on the export. Nothing should legitimately reach it:
 * `measurements`, the fastest-growing table here, runs a few thousand rows a
 * year. But this endpoint builds every row of every table into one object,
 * stringifies it, then gzips that, with all three live in heap at once.
 * Uncapped, it is the one request most likely to OOM a small box.
 */
const EXPORT_ROW_CAP = 50_000

/**
 * Everything this server stores about a user, as plain JSON: the read-side
 * counterpart to deleteAllUserData, for data-portability requests.
 *
 * Tables keyed by a parent rather than the user (workout_sets,
 * program_days, …) are included through buildChildExports. Photo bytes are
 * not: see EXPORT_SKIPPED_CHILDREN.
 */
export async function exportUserData(
  userId: number,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}

  const [profile] = await pool.execute<RowDataPacket[]>(
    `SELECT uuid AS id, username, email, name, bf_formula_sex, height_cm, height_unit,
            weight_unit, is_admin, created_at, terms_version, terms_accepted_at,
            health_consent_at
     FROM users WHERE id = ?`,
    [userId],
  )
  data.profile = profile[0] ?? null

  const tables = await exportTableRows(userId)
  Object.assign(data, tables)
  // Reporter identity left out to protect whoever filed it (Art. 15(4)).
  const [reportsAboutYou] = await pool.execute<RowDataPacket[]>(
    "SELECT reason, created_at FROM user_reports WHERE reported_id = ? ORDER BY created_at",
    [userId],
  )
  data.reportsAboutYou = reportsAboutYou
  // A table that hit the cap is incomplete. Say so rather than hand back a
  // partial Art. 15/20 export as if it were whole.
  const truncatedTables = Object.keys(tables).filter(
    (t) => tables[t].length >= EXPORT_ROW_CAP,
  )

  return { exportedAt: new Date().toISOString(), truncatedTables, ...data }
}

/**
 * The caller's rows of every table keyed to them (directly or through a parent),
 * with users.id columns rewritten to uuids.
 */
async function exportTableRows(
  userId: number,
): Promise<Record<string, RowDataPacket[]>> {
  const data: Record<string, RowDataPacket[]> = {}
  const { owned, userColumns, children } = await getUserTables()
  for (const [table, columns] of owned) {
    // users is "owned" through demo_owner_id: the caller's demo friends. Those
    // are synthetic accounts, and their raw rows (internal id, token_version,
    // password_hash) are no one's data. The wipe still deletes them.
    if (table === "users") continue
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${table} WHERE ${ownershipClause(columns)} LIMIT ${EXPORT_ROW_CAP}`,
      columns.map(() => userId),
    )
    data[table] = rows
  }
  for (const [table, child] of children) {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `${child.sql} LIMIT ${EXPORT_ROW_CAP}`,
      new Array(child.params).fill(userId),
    )
    data[table] = rows
  }
  await idsToUuids(data, userColumns)
  return data
}

/**
 * Deletes sign-ups that never got past the consent screen. Only empty
 * accounts: a row in any table the user owns (the same schema-derived list
 * "Clear All Data" uses) makes it a real account, from before the consent
 * screen or from a box with REQUIRE_TERMS_ACCEPTANCE=false. Checking only
 * programs and workouts deleted accounts that held just body stats or photos.
 */
export async function purgeUnconsentedAccounts(days = 30): Promise<number> {
  const owned = await getUserOwnedTables()
  const empty = [...owned]
    .map(
      ([table, cols]) =>
        `AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE ${cols.map((c) => "x." + c + " = u.id").join(" OR ")})`,
    )
    .join("\n       ")
  const [r] = await pool.execute<ResultSetHeader>(
    `DELETE u FROM users u
     WHERE u.terms_accepted_at IS NULL AND u.is_admin = 0
       AND u.created_at < NOW() - INTERVAL ${days | 0} DAY
       ${empty}`,
  )
  return r.affectedRows
}

/**
 * Delete every piece of data owned by a user WITHOUT deleting the account
 * itself. Used by the "Clear All Data" action: the user stays logged in and can
 * start fresh, but all of their workout, tracking and social data is gone.
 *
 * Runs in one transaction so a mid-way failure leaves nothing partially
 * wiped. Child rows reached only through a parent (workout_sets,
 * supplement_intake, progress_photo_blobs) go with their parent via
 * ON DELETE CASCADE, which is why they have no user column and never appear
 * in the list above.
 */
export async function deleteAllUserData(userId: number): Promise<void> {
  const tables = await getUserOwnedTables()
  await withTransaction(async (connection) => {
    for (const [table, columns] of tables) {
      const anonymise = WIPE_ANONYMISES[table]
      await connection.execute(
        anonymise
          ? `UPDATE ${table} SET ${anonymise} = NULL WHERE ${anonymise} = ?`
          : `DELETE FROM ${table} WHERE ${ownershipClause(columns)}`,
        anonymise ? [userId] : columns.map(() => userId),
      )
    }
  })
}
