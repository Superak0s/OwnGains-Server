import { Router, Request, Response, NextFunction } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  validateRegistration,
  validateLogin,
  validateRequired,
  validateProfileUpdate,
  validatePasswordChange,
  consentFieldErrors,
} from "@/middleware/validation.js"
import { readLocalOnlyFeatures } from "@/config/env.js"
import { deleteHealthData } from "@/features/tracking/healthConsent.js"
import {
  createUser,
  findUserByCredentials,
  findUserById,
  publicUser,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
  generateToken,
  getTokenVersion,
  getPasswordHash,
  deleteUser,
  changePassword,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshTokens,
  revokeAllSessions,
  recordConsent,
  findUserByGoogleSub,
  findUserByEmail,
  linkGoogleSub,
  unlinkGoogleSub,
  createGoogleUser,
  getGoogleSub,
} from "./auth.model.js"
import { verifyGoogleIdToken } from "./google.js"
import {
  assertNotThrottled,
  recordFailure,
  clearFailures,
  ThrottledError,
  type ThrottleScope,
} from "./throttle.model.js"
import {
  updateUserProfile,
  deleteAllUserData,
  exportUserData,
} from "./user.model.js"

const router: Router = Router()

/** assertNotThrottled, plus the Retry-After header a 429 should include. */
async function throttleGuard(
  res: Response,
  scope: ThrottleScope,
  subject: string,
): Promise<void> {
  try {
    await assertNotThrottled(scope, subject)
  } catch (err) {
    if (err instanceof ThrottledError)
      res.setHeader("Retry-After", String(err.retryAfter))
    throw err
  }
}

async function googleTokenMatches(userId: number, idToken: string): Promise<boolean> {
  if (!process.env.GOOGLE_WEB_CLIENT_ID) return false
  const sub = await getGoogleSub(userId)
  if (!sub) return false
  try {
    return (await verifyGoogleIdToken(idToken)).sub === sub
  } catch {
    return false
  }
}

/**
 * Re-check the signed-in user's password, or a fresh Google ID token for an
 * account linked to Google, before a sensitive change. Misses are
 * throttled per account (the `reauth` scope), so a stolen session can't be
 * used to guess the password behind it. 403, not 401, on a miss: the app
 * treats every 401 as an expired session.
 */
async function requireCurrentPassword(
  req: Request,
  res: Response,
  password: unknown,
  idToken?: unknown,
): Promise<void> {
  const subject = req.user!.uuid
  await throttleGuard(res, "reauth", subject)
  let ok: boolean
  if (typeof idToken === "string" && idToken) {
    ok = await googleTokenMatches(req.user!.id, idToken)
  } else {
    const hash = await getPasswordHash(req.user!.id)
    ok =
      typeof password === "string" &&
      !!hash &&
      (await verifyPassword(password, hash))
  }
  if (!ok) {
    await recordFailure("reauth", subject)
    throw new ForbiddenError("Incorrect password")
  }
  await clearFailures("reauth", subject)
}

router.post("/signup", validateRegistration, async (req: Request, res: Response) => {
  const { username, email, password, name, termsVersion, healthConsent } = req.body
  const userId = await createUser(username, email, password, name, {
    termsVersion,
    healthConsent,
  })
  const user = (await findUserById(userId))!

  const token = generateToken(user.uuid, 0)

  res.status(201).json({
    success: true,
    message: "Account created successfully",
    token,
    refreshToken: await issueRefreshToken(userId),
    user: publicUser(user),
  })
})

/**
 * Record accepting the current Terms (`termsVersion`) and/or giving or
 * withdrawing explicit health-data consent (`healthConsent`). The app sends
 * this after signup, sign-in and whenever the Terms change.
 */
router.put("/consent", authenticateToken, async (req: Request, res: Response) => {
  const body = req.body
  const errors = consentFieldErrors(body)
  if (body.termsVersion === undefined && body.healthConsent === undefined)
    errors.push("Provide termsVersion and/or healthConsent")
  if (errors.length) throw new ValidationError("Validation failed", errors)

  // Withdrawing consent erases what it covered (Art. 17(1)(b)). Only a real
  // withdrawal: the app also sends `false` from users who never consented,
  // and that must not wipe rows written before consent existed (those go
  // through `owngains purge-local-only`). Deleted first, so a failure leaves
  // the consent in place for a retry.
  if (body.healthConsent === false && req.user!.healthConsentAt)
    await deleteHealthData(req.user!.id, ["tracking", "supplements", "workouts"])
  await recordConsent(req.user!.id, {
    termsVersion: body.termsVersion,
    healthConsent: body.healthConsent,
  })
  const user = await findUserById(req.user!.id)
  res.json({ success: true, user: publicUser(user!) })
})

router.post("/signin", validateLogin, async (req: Request, res: Response) => {
  const { username, password } = req.body

  // Per-identifier backoff, keyed by what was typed rather than the account
  // it resolves to (see throttle.model.ts), so it is checked before the
  // lookup and says nothing about whether the account exists.
  await throttleGuard(res, "signin", username)

  // Always run bcrypt, even when the username doesn't exist, so the response
  // time doesn't reveal which accounts are real. The !user check still gates
  // the outcome, so a password that happens to match the dummy hash is not a
  // way in.
  const user = await findUserByCredentials(username)
  const isValid = await verifyPassword(
    password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  )
  if (!user || !isValid) {
    await recordFailure("signin", username)
    throw new UnauthorizedError("Invalid credentials")
  }
  await clearFailures("signin", username)

  // Only after the password matched, so suspension status isn't something a
  // stranger can probe for.
  if (user.disabled) throw suspendedError(user.disabledReason)

  const token = generateToken(user.uuid, user.tokenVersion)

  res.json({
    success: true,
    message: "Signed in successfully",
    token,
    refreshToken: await issueRefreshToken(user.id),
    user: publicUser(user),
  })
})

function suspendedError(reason: string | null): ForbiddenError {
  return new ForbiddenError(
    `This account has been suspended. Reason: ${reason ?? "not given"}. ` +
      "To contest it, contact this server's operator.",
    "ACCOUNT_DISABLED",
  )
}

// Unset on self-hosted servers, so the path falls through to the 404 handler.
const googleEnabled = (_req: Request, _res: Response, next: NextFunction) =>
  process.env.GOOGLE_WEB_CLIENT_ID ? next() : next("router")

/**
 * POST /api/auth/google
 *
 * Signs in with a Google ID token: by its `sub`, else by linking the account
 * with the same verified email once its `password` is given, else by creating
 * one. A new account records `termsVersion`/`healthConsent` exactly as /signup does.
 */
router.post("/google", googleEnabled, async (req: Request, res: Response) => {
  const { idToken, password, termsVersion, healthConsent } = req.body
  if (typeof idToken !== "string" || !idToken || idToken.length > 4096)
    throw new ValidationError("idToken is required", null, "ID_TOKEN_REQUIRED")
  const errors = consentFieldErrors(req.body)
  if (errors.length) throw new ValidationError("Validation failed", errors)

  const google = await verifyGoogleIdToken(idToken)
  let user = await findUserByGoogleSub(google.sub)
  let created = false
  if (!user) {
    user = await findUserByEmail(google.email)
    if (user) {
      if (user.googleSub)
        throw new ConflictError(
          "This email belongs to an account linked to another Google account",
          "GOOGLE_ACCOUNT_MISMATCH",
        )
      // Signup never verifies an email, so whoever created this account may not
      // own the Google account. Linking needs proof of both.
      if (typeof password !== "string" || !password)
        throw new ConflictError(
          "An OwnGains account already uses this email. Enter its password to link your Google account.",
          "GOOGLE_LINK_NEEDS_PASSWORD",
          { username: user.username },
        )
      await throttleGuard(res, "signin", user.username)
      if (!user.hasPassword || !(await verifyPassword(password, user.password_hash ?? DUMMY_PASSWORD_HASH))) {
        await recordFailure("signin", user.username)
        throw new UnauthorizedError("Incorrect password", "GOOGLE_LINK_PASSWORD_INVALID")
      }
      await clearFailures("signin", user.username)
      if (user.disabled) throw suspendedError(user.disabledReason)
      if (!(await linkGoogleSub(user.id, google.sub)))
        throw new ConflictError(
          "This email belongs to an account linked to another Google account",
          "GOOGLE_ACCOUNT_MISMATCH",
        )
      user = await findUserByGoogleSub(google.sub)
    } else {
      await createGoogleUser(google.email, google.name, google.sub, {
        termsVersion,
        healthConsent,
      })
      user = await findUserByGoogleSub(google.sub)
      created = true
    }
  }
  if (!user) throw new UnauthorizedError("Invalid Google token", "GOOGLE_TOKEN_INVALID")
  if (user.disabled) throw suspendedError(user.disabledReason)

  res.status(created ? 201 : 200).json({
    success: true,
    message: created ? "Account created successfully" : "Signed in successfully",
    token: generateToken(user.uuid, user.tokenVersion),
    refreshToken: await issueRefreshToken(user.id),
    user: publicUser(user),
  })
})

/**
 * DELETE /api/auth/google
 *
 * Unlinks the Google account after re-checking the password. An account with
 * no password can't unlink, since Google is then its only way in.
 */
router.delete("/google", authenticateToken, async (req: Request, res: Response) => {
  if (!req.user!.hasPassword)
    throw new ForbiddenError(
      "This account signs in with Google and has no password, so Google can't be unlinked",
      "NO_PASSWORD",
    )
  await requireCurrentPassword(req, res, req.body?.password)
  await unlinkGoogleSub(req.user!.id)
  res.json({
    success: true,
    message: "Google account unlinked",
    user: publicUser({ ...req.user!, googleLinked: false }),
  })
})

router.get("/me", authenticateToken, async (req: Request, res: Response) => {
  res.json({ success: true, user: publicUser(req.user!) })
})

function addBodyProfileUpdates(
  heightCm: unknown,
  bfFormulaSex: unknown,
  updates: Record<string, string | number>,
): void {
  // The app keeps height on-device. This is the only way it reaches the
  // server, which needs it to re-check a body-fat percentage.
  if (heightCm !== undefined) updates.height_cm = Number(heightCm)

  // Which branch of the US-Navy formula to use, stored once instead of being
  // resent with every body-fat log. The column had no writer at all before.
  if (bfFormulaSex !== undefined) {
    if (bfFormulaSex !== "male" && bfFormulaSex !== "female")
      throw new ValidationError('bfFormulaSex must be "male" or "female"')
    updates.bf_formula_sex = bfFormulaSex
  }
}

router.put("/profile", authenticateToken, validateProfileUpdate, async (req: Request, res: Response) => {
  const { name, email, heightCm, bfFormulaSex, currentPassword, idToken } = req.body
  const updates: Record<string, string | number> = {}

  if (name !== undefined) updates.name = name

  // Changing the address is changing who can claim the account, so it takes
  // the password, like changing the password does. Re-sending the current
  // address (a client that PUTs the whole profile) is not a change.
  const emailChanges =
    email !== undefined &&
    String(email).toLowerCase() !== req.user!.email.toLowerCase()
  if (emailChanges) {
    if ((typeof currentPassword !== "string" || !currentPassword) && !idToken)
      throw new ValidationError(
        "currentPassword is required to change email",
        null,
        "CURRENT_PASSWORD_REQUIRED",
      )
    await requireCurrentPassword(req, res, currentPassword, idToken)
    updates.email = email
  }

  // Both exist only to re-check a body-fat log, so a box that doesn't store
  // tracking has no reason to keep them. Ignored rather than refused, so an
  // app that PUTs the whole profile still saves the rest.
  if (!readLocalOnlyFeatures().includes("tracking"))
    addBodyProfileUpdates(heightCm, bfFormulaSex, updates)

  if (Object.keys(updates).length === 0) {
    return res.json({
      success: true,
      message: "No changes provided",
      user: publicUser(req.user!),
    })
  }

  try {
    await updateUserProfile(req.user!.id, updates)
  } catch (err) {
    // A taken address is the one thing this route can still leak. Each probe
    // costs a reauth failure, so the per-account backoff bounds the rate.
    if (emailChanges && (err as { code?: string }).code === "ACCOUNT_UNAVAILABLE")
      await recordFailure("reauth", req.user!.uuid)
    throw err
  }
  const user = await findUserById(req.user!.id)

  res.json({
    success: true,
    message: "Profile updated successfully",
    user: user && publicUser(user),
  })
})

/**
 * DELETE /api/auth/account/data
 *
 * Wipes ALL of the authenticated user's data (workouts, tracking, social)
 * while keeping the account itself. Requires an explicit confirmation token
 * so it can't be triggered accidentally, and the current password for the
 * same reason DELETE /account does: a stolen phone already has a valid token,
 * and nothing brings the data back.
 */
router.delete("/account/data", authenticateToken, validateRequired(["confirmDelete"]), async (req: Request, res: Response) => {
  if (req.body.confirmDelete !== "DELETE_ALL_DATA") {
    throw new ValidationError(
      'Must confirm deletion with confirmDelete: "DELETE_ALL_DATA"',
    )
  }
  if (req.body.password === undefined && req.body.idToken === undefined)
    throw new ValidationError("password is required", null, "PASSWORD_REQUIRED")
  await requireCurrentPassword(req, res, req.body.password, req.body.idToken)

  await deleteAllUserData(req.user!.id)

  res.json({ success: true, message: "All data deleted successfully" })
})

/**
 * DELETE /api/auth/account
 *
 * Permanently deletes the account and everything it owns. Re-checks the
 * password (or, for a Google account, a fresh `idToken`) because a stolen
 * phone already has a valid token, and this is the one action nothing can undo.
 */
router.delete("/account", authenticateToken, async (req: Request, res: Response) => {
  if (req.body?.password === undefined && req.body?.idToken === undefined)
    throw new ValidationError("password is required", null, "PASSWORD_REQUIRED")
  await requireCurrentPassword(req, res, req.body.password, req.body.idToken)
  await deleteUser(req.user!.id)
  res.json({ success: true, message: "Account deleted successfully" })
})

/**
 * POST /api/auth/refresh
 *
 * Spends the opaque refresh token in the body and returns a fresh access
 * token plus its replacement. Deliberately unauthenticated: an expired access
 * token is the normal reason to be here, and one that is still valid buys the
 * caller nothing, so it is never read.
 *
 * Rotation is mandatory - the presented token is dead the moment this
 * succeeds. Presenting it again is a replay, which kills the whole family
 * (see rotateRefreshToken) and answers with code REFRESH_REUSED.
 */
router.post("/refresh", async (req: Request, res: Response) => {
  const presented = req.body?.refreshToken

  // An access token never renews itself: that let a stolen 15-minute token
  // live forever, invisible to reuse detection.
  if (typeof presented !== "string" || !presented)
    throw new UnauthorizedError("Refresh token required", "REFRESH_TOKEN_REQUIRED")

  const result = await rotateRefreshToken(presented)
  if (!result.ok) {
    throw new UnauthorizedError(
      "Invalid refresh token",
      result.reused ? "REFRESH_REUSED" : undefined,
    )
  }

  res.json({
    success: true,
    token: generateToken(result.userUuid, result.tokenVersion),
    refreshToken: result.token,
  })
})

/**
 * POST /api/auth/signout
 *
 * Revokes the presented refresh token (204). An unknown or already-revoked
 * token still answers 204: sign-out must not report whether it existed.
 *
 * With `allDevices: true` it is "sign out everywhere", the answer to a lost
 * phone: every refresh token is revoked AND token_version is bumped, so the
 * access tokens still in flight die on their next request too. That also kills
 * the caller's own token, so this device gets a fresh pair back (200) and
 * stays signed in.
 */
router.post("/signout", authenticateToken, async (req: Request, res: Response) => {
  const { refreshToken, allDevices } = req.body
  if (allDevices === true) {
    await revokeAllSessions(req.user!.id)
    return res.json({
      success: true,
      message: "Signed out on all devices",
      token: generateToken(req.user!.uuid, await getTokenVersion(req.user!.id)),
      refreshToken: await issueRefreshToken(req.user!.id),
    })
  }
  await revokeRefreshTokens(req.user!.id, {
    token: typeof refreshToken === "string" ? refreshToken : undefined,
  })
  res.status(204).end()
})

/**
 * PUT /api/auth/password
 *
 * changePassword bumps token_version, which invalidates every outstanding
 * JWT, including the caller's. We hand back a newly signed one so the
 * device that made the change stays signed in and every other device is
 * signed out, which is the point of changing a password.
 */
router.put("/password", authenticateToken, validatePasswordChange, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body

  if (!req.user!.hasPassword)
    throw new ForbiddenError(
      "This account signs in with Google and has no password to change",
      "NO_PASSWORD",
    )
  await requireCurrentPassword(req, res, currentPassword)
  await changePassword(req.user!.id, newPassword)

  res.json({
    success: true,
    message: "Password changed successfully",
    token: generateToken(req.user!.uuid, await getTokenVersion(req.user!.id)),
    refreshToken: await issueRefreshToken(req.user!.id),
  })
})

/**
 * GET /api/auth/account/export
 *
 * Everything this server holds about the caller, as JSON. Progress photo
 * bytes are not included: they live in their own table, keyed by photo.
 */
router.get("/account/export", authenticateToken, async (req: Request, res: Response) => {
  res.json({ success: true, data: await exportUserData(req.user!.id) })
})

export default router
