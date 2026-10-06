import jwt from "jsonwebtoken"
import { createHash, randomBytes, randomUUID } from "crypto"
import type { SignOptions } from "jsonwebtoken"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { AuthUser, ConsentInput } from "./user.types.js"
import { ConflictError, NotFoundError } from "@/middleware/errorHandler.js"
import { parseUuidParam } from "@/middleware/validation.js"
import { pool, withTransaction } from "@/config/database.js"
import { envInt } from "@/config/env.js"
import { hashPassword, verifyPassword } from "./password.js"
import { logger } from "@/utils/logger.js"

export { verifyPassword, DUMMY_PASSWORD_HASH } from "./password.js"

interface AuthUserRow extends RowDataPacket {
  id: number
  uuid: string
  username: string
  email: string
  password_hash?: string
  name: string
  is_admin: number
  created_at: Date
  height_cm: number | null
  bf_formula_sex: "male" | "female" | null
  terms_version: string | null
  terms_accepted_at: Date | null
  health_consent_at: Date | null
}

// Every lookup that builds an AuthUser selects the same profile columns, so
// req.user (and so publicUser) is never missing a field.
const USER_COLS = `id, uuid, username, email, name, is_admin, created_at,
       height_cm, bf_formula_sex, terms_version, terms_accepted_at,
       health_consent_at`

function toAuthUser(u: AuthUserRow): AuthUser & { password_hash?: string } {
  return {
    id: u.id,
    uuid: u.uuid,
    username: u.username,
    email: u.email,
    password_hash: u.password_hash,
    name: u.name,
    isAdmin: !!u.is_admin,
    createdAt: u.created_at,
    // decimalNumbers on the pool: height_cm is already a number here.
    heightCm: u.height_cm ?? null,
    bfFormulaSex: u.bf_formula_sex ?? null,
    termsVersion: u.terms_version ?? null,
    termsAcceptedAt: u.terms_accepted_at ?? null,
    healthConsentAt: u.health_consent_at ?? null,
  }
}

export async function createUser(
  username: string,
  email: string,
  password: string,
  name?: string,
  consent: ConsentInput = {},
): Promise<number> {
  const passwordHash = await hashPassword(password)
  const termsVersion = consent.termsVersion ?? null

  // uq_users_username / uq_users_email do the uniqueness check, so there is no
  // pre-check SELECT to lose the race against two simultaneous signups.
  let insertId: number
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users (uuid, username, email, password_hash, name, is_admin,
         terms_version, terms_accepted_at, health_consent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IS NULL, NULL, NOW()), IF(?, NOW(), NULL), NOW())`,
      [
        randomUUID(), username, email, passwordHash, name || username, 0,
        termsVersion, termsVersion, consent.healthConsent === true,
      ],
    )
    insertId = result.insertId
  } catch (err) {
    throw asDuplicateUserError(err)
  }
  if (termsVersion !== null)
    await pool.execute(
      "INSERT INTO consent_events (user_id, kind, version, granted) VALUES (?, 'terms', ?, 1)",
      [insertId, termsVersion],
    )
  if (consent.healthConsent === true)
    await pool.execute(
      "INSERT INTO consent_events (user_id, kind, granted) VALUES (?, 'health', 1)",
      [insertId],
    )

  // With BOOTSTRAP_ADMIN_USERNAME set, that username (and only it) becomes
  // admin on signup, so a public box can't be claimed by whoever registers
  // first after deploy. Unset (the self-hosted default), the first-ever user
  // becomes admin as before.
  const bootstrapAdmin = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim()
  if (bootstrapAdmin) {
    if (username.toLowerCase() === bootstrapAdmin.toLowerCase())
      await pool.execute(`UPDATE users SET is_admin = 1 WHERE id = ?`, [insertId])
    return insertId
  }

  // The first-ever user becomes admin. Decided AFTER the insert and against
  // MIN(id) rather than from a COUNT(*) taken before it: two signups racing on
  // a fresh box both read a count of 0 and both came out admin. Exactly one row
  // can hold the lowest id, so this is the same rule without the race. The
  // derived table is required: MySQL/MariaDB refuse a bare subquery on the
  // table being updated.
  await pool.execute(
    `UPDATE users SET is_admin = 1
     WHERE id = ? AND id = (SELECT m FROM (SELECT MIN(id) AS m FROM users) AS first)`,
    [insertId],
  )
  return insertId
}

/**
 * Turn a MySQL duplicate-key error on `users` into a ConflictError. Anything
 * else is rethrown untouched.
 *
 * Deliberately one message and one code for both keys: "Email already
 * registered" told anyone which addresses have an account here. Fully closing
 * that needs an emailed verification step, which a box with no mail server
 * can't send.
 */
const ACCOUNT_CONFLICT_MESSAGE = "That username or email is unavailable"

export function asDuplicateUserError(err: unknown): unknown {
  const e = err as { errno?: number; message?: string }
  if (e?.errno !== 1062) return err
  return new ConflictError(ACCOUNT_CONFLICT_MESSAGE, "ACCOUNT_UNAVAILABLE")
}

export async function findUserByCredentials(
  usernameOrEmail: string,
): Promise<
  | (AuthUser & {
      password_hash?: string
      disabled: boolean
      disabledReason: string | null
      tokenVersion: number
    })
  | null
> {
  // A username can equal someone's email (admins are made via the CLI, and
  // old rows predate the @ ban), so both arms of the WHERE can match. Prefer
  // the exact username and take one row. Which row MySQL returned first used
  // to decide, and that is not an identity rule.
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT ${USER_COLS}, password_hash, token_version,
            disabled_at IS NOT NULL AS disabled, disabled_reason
     FROM users WHERE username = ? OR email = ?
     ORDER BY (username = ?) DESC LIMIT 1`,
    [usernameOrEmail, usernameOrEmail, usernameOrEmail],
  )
  const row = users[0]
  return row
    ? {
        ...toAuthUser(row),
        disabled: !!row.disabled,
        disabledReason: (row.disabled_reason as string | null) ?? null,
        // Read here so signin doesn't go back for it (getTokenVersion).
        tokenVersion: Number(row.token_version ?? 0),
      }
    : null
}

export async function findUserByUsername(
  username: string,
): Promise<AuthUser | null> {
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT ${USER_COLS} FROM users WHERE username = ?`,
    [username],
  )
  return users[0] ? toAuthUser(users[0]) : null
}

export async function findUserById(userId: number): Promise<AuthUser | null> {
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT ${USER_COLS} FROM users WHERE id = ?`,
    [userId],
  )
  return users[0] ? toAuthUser(users[0]) : null
}

/**
 * The trainee a trainer may act as, or null. One query for what trainer mode
 * used to check in three serial round trips (user, friendship, grant) on every
 * request with X-Trainee-Id, and unlike findUserByUuid it skips a
 * suspended account the way findUserForAuth does, so a trainer can't keep
 * reading and writing the data of someone an admin has suspended.
 *
 * Friendship AND grant, matching resolveFriendAccess(): removeFriend deletes
 * the grant rows, so the friendship check is belt-and-braces against any other
 * path that drops a friendship without tearing grants down.
 */
export async function findTraineeForTrainer(
  trainerId: number,
  traineeUuid: string,
): Promise<AuthUser | null> {
  const [rows] = await pool.execute<AuthUserRow[]>(
    `SELECT ${USER_COLS} FROM users u
     WHERE u.uuid = ? AND u.disabled_at IS NULL
       AND EXISTS(SELECT 1 FROM friendships f
                   WHERE f.user_id = LEAST(u.id, ?) AND f.friend_id = GREATEST(u.id, ?)
                     AND f.status = 'accepted')
       AND EXISTS(SELECT 1 FROM sharing_permissions sp
                   WHERE sp.from_user_id = u.id AND sp.to_user_id = ?
                     AND sp.permission_type = 'trainer')`,
    [traineeUuid, trainerId, trainerId, trainerId],
  )
  return rows[0] ? toAuthUser(rows[0]) : null
}

/** Look a user up by the public uuid a client sent. */
export async function findUserByUuid(uuid: string): Promise<AuthUser | null> {
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT ${USER_COLS} FROM users WHERE uuid = ?`,
    [uuid],
  )
  return users[0] ? toAuthUser(users[0]) : null
}

/**
 * Resolve a client-supplied user uuid (path param or body field) to the user's
 * internal id: 400 when it isn't a uuid, 404 when no such user exists. Every
 * route that takes a user from the outside goes through here, so the numeric
 * id never has to leave the server.
 */
export async function requireUser(
  value: unknown,
  name: string,
): Promise<{ id: number; uuid: string }> {
  const uuid = parseUuidParam(value, name)
  const [rows] = await pool.execute<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM users WHERE uuid = ?",
    [uuid],
  )
  if (!rows[0]) throw new NotFoundError("User")
  return { id: rows[0].id, uuid }
}

/** The shape a user takes in any response: the uuid stands in for `id`. */
export const publicUser = (u: AuthUser) => ({
  id: u.uuid,
  username: u.username,
  email: u.email,
  name: u.name,
  isAdmin: u.isAdmin,
  createdAt: u.createdAt,
  // null means never set. It is deliberately not defaulted to "male" here, so the
  // app can tell an unset formula from a choice.
  heightCm: u.heightCm,
  bfFormulaSex: u.bfFormulaSex,
  termsVersion: u.termsVersion,
  termsAcceptedAt: u.termsAcceptedAt,
  healthConsentAt: u.healthConsentAt,
})

/**
 * Record accepting a Terms version and/or giving or withdrawing health-data
 * consent. Giving it again keeps the original timestamp, and withdrawing clears it.
 */
export async function recordConsent(
  userId: number,
  { termsVersion, healthConsent }: ConsentInput,
): Promise<void> {
  const sets: string[] = []
  const values: (string | number)[] = []
  if (termsVersion !== undefined) {
    sets.push("terms_version = ?", "terms_accepted_at = NOW()")
    values.push(termsVersion)
  }
  if (healthConsent !== undefined)
    sets.push(
      healthConsent
        ? "health_consent_at = COALESCE(health_consent_at, NOW())"
        : "health_consent_at = NULL",
    )
  if (!sets.length) return
  await withTransaction(async (conn) => {
    if (termsVersion !== undefined)
      await conn.execute(
        "INSERT INTO consent_events (user_id, kind, version, granted) VALUES (?, 'terms', ?, 1)",
        [userId, termsVersion],
      )
    // Only a change of state is an event. The app re-sends `false` from users
    // who never consented.
    if (healthConsent !== undefined)
      await conn.execute(
        `INSERT INTO consent_events (user_id, kind, granted)
         SELECT id, 'health', ? FROM users
         WHERE id = ? AND (health_consent_at IS NULL) = ?`,
        [healthConsent ? 1 : 0, userId, healthConsent ? 1 : 0],
      )
    await conn.execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [
      ...values,
      userId,
    ])
  })
}

/**
 * Profile plus token_version in one row: authenticateToken needs both on
 * every request, and they live in the same table. Keyed by uuid, which is what
 * a JWT contains.
 *
 * A suspended account (disabled_at set) reads as absent, so every caller
 * (the HTTP middleware and the WS auth/heartbeat alike) refuses it without
 * having to know suspension exists.
 */
export async function findUserForAuth(
  uuid: string,
): Promise<{ user: AuthUser; tokenVersion: number } | null> {
  const [rows] = await pool.execute<
    (AuthUserRow & { token_version: number })[]
  >(
    `SELECT ${USER_COLS}, token_version
     FROM users WHERE uuid = ? AND disabled_at IS NULL`,
    [uuid],
  )
  const row = rows[0]
  return row
    ? { user: toAuthUser(row), tokenVersion: row.token_version ?? 0 }
    : null
}

/** The stored hash, for re-checking a signed-in user's password. */
export async function getPasswordHash(userId: number): Promise<string | null> {
  const [rows] = await pool.execute<AuthUserRow[]>(
    "SELECT password_hash FROM users WHERE id = ?",
    [userId],
  )
  return rows[0]?.password_hash ?? null
}

export function generateToken(userUuid: string, tokenVersion: number): string {
  return jwt.sign({ userId: userUuid, tokenVersion }, process.env.JWT_SECRET!, {
    expiresIn: (process.env.JWT_EXPIRES_IN || "15m") as SignOptions["expiresIn"],
    algorithm: "HS256",
  })
}

/**
 * Current token version for a user, embedded in every JWT issued to them
 * and checked on every authenticated request. Bumping it (see
 * changePassword) invalidates every outstanding token at once, since none of
 * them carry the new version.
 */
export async function getTokenVersion(userId: number): Promise<number> {
  const [rows] = await pool.execute<(RowDataPacket & { token_version: number })[]>(
    "SELECT token_version FROM users WHERE id = ?",
    [userId],
  )
  return rows[0]?.token_version ?? 0
}

/**
 * Permanently delete an account. The caller re-checks the password first.
 * Every user-owned table declares ON DELETE CASCADE on users(id), so dropping
 * the row takes the user's workouts, tracking and social data with it. Reports
 * filed by or against the user are kept (SET NULL) for moderation.
 * The uuid goes into deleted_accounts in the same transaction, so a backup
 * restore can't resurrect the account (see purgeDeletedAccounts).
 */
export async function deleteUser(userId: number): Promise<void> {
  await withTransaction(async (conn) => {
    await conn.execute(
      "INSERT IGNORE INTO deleted_accounts (uuid) SELECT uuid FROM users WHERE id = ?",
      [userId],
    )
    await conn.execute("DELETE FROM users WHERE id = ?", [userId])
    // A custom exercise name can identify its author, and the catalog row
    // would otherwise remain after they are gone.
    // ponytail: a set logged against a just-created exercise in the same instant
    // can lose this race and fail its insert. The app's offline queue retries it.
    await conn.execute(
      `DELETE e FROM exercises e
       WHERE NOT EXISTS (SELECT 1 FROM workout_sets ws WHERE ws.exercise_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM program_exercises pe WHERE pe.exercise_id = e.id)`,
    )
  })
}

/**
 * Re-deletes any account that came back from a backup restore, then drops
 * tombstones older than the oldest backup that could still contain them.
 * Returns how many resurrected accounts were deleted.
 */
export async function purgeDeletedAccounts(
  days = envInt("BACKUP_RETENTION_DAYS", 30, 1),
): Promise<number> {
  const [r] = await pool.execute<ResultSetHeader>(
    "DELETE u FROM users u JOIN deleted_accounts d ON d.uuid = u.uuid",
  )
  await pool.execute(
    `DELETE FROM deleted_accounts WHERE deleted_at < NOW() - INTERVAL ${(days + 2) | 0} DAY`,
  )
  return r.affectedRows
}

/**
 * Deletes sign-ups that never got past the consent screen. Only empty
 * accounts: one that predates the consent screen and holds a program or
 * workouts is a real account, not an abandoned sign-up.
 */
export async function purgeUnconsentedAccounts(days = 30): Promise<number> {
  const [r] = await pool.execute<ResultSetHeader>(
    `DELETE u FROM users u
     WHERE u.terms_accepted_at IS NULL AND u.is_admin = 0
       AND u.created_at < NOW() - INTERVAL ${days | 0} DAY
       AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM workouts w WHERE w.user_id = u.id)`,
  )
  return r.affectedRows
}

export async function changePassword(
  userId: number,
  newPassword: string,
): Promise<boolean> {
  const hash = await hashPassword(newPassword)
  // Bump token_version too, so tokens issued before the password change
  // (e.g. to whoever leaked it) stop working immediately. Refresh tokens are
  // revoked in the same transaction: a leaked one must not remain valid past the
  // password it was meant to be revoked with just because a second statement
  // failed.
  await revokeAllSessions(userId, "password_hash = ?", [hash])
  return true
}

/**
 * Bump token_version (killing every access token) and revoke every refresh
 * token, atomically. `extraSet` lets a caller change more of the user row in
 * the same UPDATE (a new password hash, a suspension). Constant SQL only:
 * values go through `extraParams`.
 */
export async function revokeAllSessions(
  userId: number,
  extraSet?: string,
  extraParams: (string | number | null)[] = [],
): Promise<boolean> {
  return withTransaction(async (conn) => {
    const [result] = await conn.execute<ResultSetHeader>(
      `UPDATE users SET ${extraSet ? `${extraSet}, ` : ""}token_version = token_version + 1
       WHERE id = ?`,
      [...extraParams, userId],
    )
    await conn.execute(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    )
    return result.affectedRows > 0
  })
}

/**
 * Suspend (or lift the suspension of) an account. Suspending also revokes
 * every token it has, so a signed-in device is out on its next request and
 * its socket on the next heartbeat. Returns false for an unknown user.
 */
export async function setUserDisabled(
  userId: number,
  disabled: boolean,
  reason: string | null = null,
): Promise<boolean> {
  if (disabled)
    return revokeAllSessions(userId, "disabled_at = NOW(), disabled_reason = ?", [reason])
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = ?",
    [userId],
  )
  return result.affectedRows > 0
}

// -----------------------------------------------------------------------------
// Refresh tokens
// -----------------------------------------------------------------------------

const REFRESH_TTL_DAYS = 30

/**
 * The stored form of a refresh token. A plain digest is enough here - the
 * token is 256 bits of CSPRNG output, not a guessable password, so there is
 * nothing for bcrypt to slow down.
 */
const hashRefreshToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex")

/**
 * Create a refresh token. Passing an existing `familyId` continues a rotation
 * chain. Omitting it starts a new one (i.e. a fresh sign-in).
 */
export async function issueRefreshToken(
  userId: number,
  familyId: string = randomUUID(),
): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await pool.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, issued_at, expires_at)
     VALUES (?, ?, ?, NOW(), NOW() + INTERVAL ${REFRESH_TTL_DAYS} DAY)`,
    [userId, hashRefreshToken(token), familyId],
  )
  return token
}

/**
 * Rotation writes a row every 15 minutes per device, and expired ones are dead
 * weight. This used to run unbounded on every token issue, so the first
 * refresh after downtime paid for the whole backlog inside a user's request.
 * The 5-minute cleanup job now sweeps it in batches.
 */
export async function purgeExpiredRefreshTokens(batch = 5000): Promise<number> {
  const [r] = await pool.execute<ResultSetHeader>(
    `DELETE FROM refresh_tokens WHERE expires_at < NOW() LIMIT ${Number(batch) | 0}`,
  )
  return r.affectedRows
}

type RotateResult =
  | { ok: true; userId: number; userUuid: string; tokenVersion: number; token: string }
  | { ok: false; reused: boolean }

/**
 * Spend a refresh token and issue its replacement.
 *
 * The UPDATE is the atomic gate: two simultaneous presentations of the same
 * token cannot both claim it, so a replay is caught even under a race. A
 * token that was already spent means a copy leaked - the legitimate client's
 * or an attacker's, indistinguishable - so the entire family is revoked and
 * everyone has to sign in again.
 */
export async function rotateRefreshToken(presented: string): Promise<RotateResult> {
  const hash = hashRefreshToken(presented)

  const [claim] = await pool.execute<ResultSetHeader>(
    `UPDATE refresh_tokens SET used_at = NOW()
     WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [hash],
  )

  const [rows] = await pool.execute<
    (RowDataPacket & {
      user_id: number
      user_uuid: string
      family_id: string
      used: number
      token_version: number
    })[]
  >(
    `SELECT rt.user_id, u.uuid AS user_uuid, rt.family_id, u.token_version,
            rt.used_at IS NOT NULL AS used
     FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = ? AND u.disabled_at IS NULL`,
    [hash],
  )
  const row = rows[0]
  if (!row) return { ok: false, reused: false }

  if (claim.affectedRows === 0) {
    // Revoked or expired is an ordinary dead token, while already-used is a replay.
    if (!row.used) return { ok: false, reused: false }
    await pool.execute(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL",
      [row.family_id],
    )
    logger.warn("[AUDIT] refresh token reuse, session family revoked", { user: row.user_uuid })
    return { ok: false, reused: true }
  }

  return {
    ok: true,
    userId: row.user_id,
    userUuid: row.user_uuid,
    tokenVersion: Number(row.token_version ?? 0),
    token: await issueRefreshToken(row.user_id, row.family_id),
  }
}

/**
 * Revoke one refresh token, or every one the user holds. Scoped by user_id so
 * a caller can only ever kill their own sessions. An unknown token is a no-op:
 * sign-out must not report whether it existed.
 */
export async function revokeRefreshTokens(
  userId: number,
  opts: { token?: string; allDevices?: boolean },
): Promise<void> {
  if (opts.allDevices) {
    await pool.execute(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    )
  } else if (opts.token) {
    await pool.execute(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL",
      [userId, hashRefreshToken(opts.token)],
    )
  }
}

export async function setUserAdmin(userId: number, isAdmin: boolean): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE users SET is_admin = ? WHERE id = ?`,
    [isAdmin ? 1 : 0, userId],
  )
  return result.affectedRows > 0
}

/**
 * Every account, admins first. `owngains add`/`remove` need the exact spelling of
 * a username, and listing only admins meant opening MySQL to find out what a
 * non-admin's is.
 */
export async function listUsers(): Promise<(AuthUser & { disabled: boolean })[]> {
  const [rows] = await pool.execute<AuthUserRow[]>(
    `SELECT ${USER_COLS}, disabled_at IS NOT NULL AS disabled FROM users
     ORDER BY is_admin DESC, id ASC`,
  )
  return rows.map((r) => ({ ...toAuthUser(r), disabled: !!r.disabled }))
}

export async function listAdmins(): Promise<AuthUser[]> {
  const [rows] = await pool.execute<AuthUserRow[]>(
    `SELECT ${USER_COLS} FROM users WHERE is_admin = 1 ORDER BY id ASC`,
  )
  return rows.map(toAuthUser)
}
