import { Request, Response, NextFunction } from "express"
import { ValidationError } from "./errorHandler.js"

// Prevents oversized strings from passing body-size checks and being stored.
// Values match the DB column sizes in config/schema.sql.
//
// These all throw synchronously. Express 5 forwards a thrown error to the
// error handler on its own, so none of them need a try/catch + next(err).

const MAX_LENGTHS = {
  username: 20,
  email: 255,
  name: 128,
  dayTitle: 255,
  exerciseName: 255,
  note: 1000,
  time: 8,
  machineName: 100,
} as const

const MUSCLE_NAME_MAX = 128

/**
 * Parse a path param / body field that must be an integer id, rejecting
 * anything else with a 400 naming the field. Ids are auto-increment columns,
 * so zero and negatives are as invalid as non-numbers.
 */
export function parseIntParam(value: string, name: string): number {
  // Strict, not parseInt: "12abc" used to address workout 12 and "5e9" workout
  // 5, so a typo'd or truncated id silently hit a real row instead of 400ing.
  if (!/^\d+$/.test(value.trim()))
    throw new ValidationError(`Invalid ${name}`)
  const n = Number(value.trim())
  if (!Number.isSafeInteger(n) || n < 1)
    throw new ValidationError(`Invalid ${name}`)
  return n
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a value is a user uuid. Checked before any `WHERE uuid = ?`: MySQL
 * compares a CHAR column against a number numerically, so a bare `3` would
 * match every uuid that happens to start with "3".
 */
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v)

/**
 * Parse a path param / body field that must be a user uuid, rejecting anything
 * else with a 400 naming the field. Lower-cased, since that is how every uuid
 * is stored.
 */
export function parseUuidParam(value: unknown, name: string): string {
  if (!isUuid(value)) throw new ValidationError(`Invalid ${name}`)
  return value.toLowerCase()
}

/**
 * A repeated query key (`?split=a&split=b`) arrives as an array, which then
 * stringifies to "a,b" inside a WHERE clause. Every caller wants one value.
 */
export function queryString(
  req: Request,
  key: string,
): string | undefined {
  const v = req.query[key]
  if (v === undefined) return undefined
  if (typeof v !== "string")
    throw new ValidationError(`${key} must be given at most once`)
  return v
}

/**
 * Read a caller-supplied `?limit=` (or another numeric query key), falling
 * back to a default and clamping to a ceiling so a client can't ask for an
 * unbounded result set.
 */
export function queryLimit(
  req: Request,
  { def, max, key = "limit" }: { def: number; max: number; key?: string },
): number {
  // queryString, not req.query[key] directly: a repeated `?limit=1&limit=2`
  // arrives as an array, stringifies to "1,2" and silently became 1.
  // Floor at 1 as well as capping: `?limit=-1` is truthy, so without the
  // Math.max it reached `LIMIT ?` as a negative and every list endpoint 500'd.
  return Math.min(Math.max(parseInt(queryString(req, key) ?? "", 10) || def, 1), max)
}

export const validateEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
export const validateUsername = (v: string) => /^[a-zA-Z0-9_]{3,20}$/.test(v)

const PASSWORD_MIN_LENGTH = 8
/** bcrypt only reads the first 72 bytes. Anything past that was silently ignored. */
const PASSWORD_MAX_BYTES = 72
const PASSWORD_POLICY_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters and at most ${PASSWORD_MAX_BYTES} bytes`

/**
 * The policy for a NEW password (signup, change, CLI create/reset), never
 * applied at signin, where an account created under an older policy must still
 * get in. Null when the password is acceptable.
 *
 * Length only, any characters. The ceiling is in bytes, not characters,
 * because that is what bcrypt truncates.
 */
export function passwordPolicyError(v: unknown): string | null {
  if (typeof v !== "string" || !v) return "Password is required"
  if (v.length < PASSWORD_MIN_LENGTH || Buffer.byteLength(v, "utf8") > PASSWORD_MAX_BYTES)
    return PASSWORD_POLICY_MESSAGE
  return null
}
const validatePositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && v > 0 && !isNaN(v)
const validateInteger = (v: unknown): v is number => Number.isInteger(v)
const validateISODate = (v: string) => !isNaN(new Date(v).getTime())

/**
 * Read an optional client-supplied timestamp for an entry the user is
 * backdating to an earlier day, returning null when none was sent.
 *
 * Clients send a timezone-less local stamp (a calendar day-tap defaults to
 * 09:00 that day), so an entry logged early in the morning (or from a phone
 * ahead of a UTC-running box) can read as slightly future here. So a day
 * of slack instead of a strict `> now`: it still catches a typo'd year.
 */
export function parseBackdatedTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value == null) return null
  if (typeof value !== "string" || !validateISODate(value))
    throw new ValidationError(`${field} must be an ISO-8601 date`)
  if (new Date(value).getTime() > Date.now() + 24 * 60 * 60 * 1000)
    throw new ValidationError(
      `${field} cannot be in the future`,
      null,
      "FUTURE_TIMESTAMP",
    )
  return value
}

function checkMaxLength(
  value: string,
  field: keyof typeof MAX_LENGTHS,
): string | null {
  const limit = MAX_LENGTHS[field]
  return value.length > limit
    ? `${field} must not exceed ${limit} characters`
    : null
}

/**
 * Check an optional muscle-group array (primaryMuscles / secondaryMuscles):
 * an array of at most MUSCLE_GROUPS_MAX non-empty strings, each capped like the
 * old single-group field. These are stored in the shared `exercises` catalog, where
 * they can never be rewritten (backfillMuscles only fills blanks), so a bad
 * shape has to stop here on every path that reaches it.
 */
const MUSCLE_GROUPS_MAX = 20

/** workouts.split and program_exercises.split_name are VARCHAR(128). */
const SPLIT_NAME_MAX = 128

function checkMuscleArray(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (value == null) return
  const ok =
    Array.isArray(value) &&
    value.length <= MUSCLE_GROUPS_MAX &&
    value.every(
      (g) =>
        typeof g === "string" && !!g.trim() && g.length <= MUSCLE_NAME_MAX,
    )
  if (!ok)
    errors.push(
      `${field} must be an array of at most ${MUSCLE_GROUPS_MAX} non-empty strings (max ${MUSCLE_NAME_MAX} chars each)`,
    )
}

/** Reject requests that are missing any of the listed body fields. */
export function validateRequired(requiredFields: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // req.body is undefined when the request arrives with no Content-Type, so
    // indexing it threw a TypeError and showed up as a 500 instead of the 400
    // this validator exists to produce.
    const body = req.body ?? {}
    const missing = requiredFields.filter(
      (f) => body[f] === undefined || body[f] === null || body[f] === "",
    )
    if (missing.length > 0) {
      throw new ValidationError(`Missing required fields: ${missing.join(", ")}`)
    }
    next()
  }
}

/**
 * Errors for the optional consent fields shared by signup and
 * PUT /api/auth/consent: `termsVersion` (the Terms/Privacy Policy version the
 * app showed, 1-32 chars) and `healthConsent` (boolean).
 */
export function consentFieldErrors(body: {
  termsVersion?: unknown
  healthConsent?: unknown
}): string[] {
  const errors: string[] = []
  const { termsVersion, healthConsent } = body
  if (
    termsVersion !== undefined &&
    (typeof termsVersion !== "string" ||
      !termsVersion.trim() ||
      termsVersion.length > 32)
  )
    errors.push("termsVersion must be a non-empty string of at most 32 characters")
  if (healthConsent !== undefined && typeof healthConsent !== "boolean")
    errors.push("healthConsent must be a boolean")
  return errors
}

export function validateRegistration(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { username, email, password } = req.body
  const errors: string[] = []

  if (!username) {
    errors.push("Username is required")
  } else {
    if (!validateUsername(username))
      errors.push(
        "Username must be 3-20 characters (letters, numbers, underscores)",
      )
    const lenErr = checkMaxLength(username, "username")
    if (lenErr) errors.push(lenErr)
  }

  if (!email) {
    errors.push("Email is required")
  } else {
    if (!validateEmail(email)) errors.push("Invalid email format")
    const lenErr = checkMaxLength(email, "email")
    if (lenErr) errors.push(lenErr)
  }

  const pwErr = passwordPolicyError(password)
  if (pwErr) errors.push(pwErr)

  errors.push(...consentFieldErrors(req.body))

  if (errors.length > 0) throw new ValidationError("Validation failed", errors)
  next()
}

export function validatePasswordChange(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { currentPassword, newPassword } = req.body
  const errors: string[] = []

  if (!currentPassword) errors.push("Current password is required")

  if (!newPassword) {
    errors.push("New password is required")
  } else {
    const pwErr = passwordPolicyError(newPassword)
    if (pwErr) errors.push(`New ${pwErr[0]!.toLowerCase()}${pwErr.slice(1)}`)
  }

  if (errors.length > 0) throw new ValidationError("Validation failed", errors)
  next()
}

export function validateProfileUpdate(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { name, email } = req.body
  const errors: string[] = []

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      errors.push("Name must be a non-empty string")
    } else {
      const lenErr = checkMaxLength(name, "name")
      if (lenErr) errors.push(lenErr)
    }
  }

  if (email !== undefined) {
    if (typeof email !== "string" || !validateEmail(email)) {
      errors.push("Invalid email format")
    } else {
      const lenErr = checkMaxLength(email, "email")
      if (lenErr) errors.push(lenErr)
    }
  }

  if (errors.length > 0) throw new ValidationError("Validation failed", errors)
  next()
}

export function validateLogin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { username, password } = req.body ?? {}
  // Strings only: an object here reached the throttle's .trim() and the
  // WHERE clause as-is. No password policy (accounts made under an older,
  // laxer one must still sign in), just a sanity ceiling well above anything
  // real (bcrypt reads 72 bytes of it anyway).
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username.trim() ||
    !password
  )
    throw new ValidationError("Username and password are required")
  if (username.length > MAX_LENGTHS.email || password.length > 1024)
    throw new ValidationError("Invalid credentials")
  next()
}

export function validateWeightEntry(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { weightKg } = req.body
  if (!validatePositiveNumber(weightKg))
    throw new ValidationError("Weight must be a positive number")
  // The 20-500 kg range is checked in logMetrics (METRIC_BOUNDS), which
  // POST /api/tracking/measurements reaches too.
  next()
}

export function validateSessionCreation(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { dayNumber, dayTitle, primaryMuscles, secondaryMuscles } = req.body
  const errors: string[] = []

  // startTime is client-supplied and lands straight in workouts.start_time,
  // which is what the 30-minute stale-session sweep measures against. Unparsed,
  // a phone with a wrong clock (or a queued offline start replayed late) opened
  // a workout that the very next 5-minute tick auto-ended.
  parseBackdatedTimestamp(req.body.startTime ?? null, "startTime")

  if (!validateInteger(dayNumber) || dayNumber < 1)
    errors.push("Day number must be a positive integer")

  // typeof first: a number or object here reached .trim() and 500'd.
  if (typeof dayTitle !== "string" || !dayTitle.trim()) {
    errors.push("Day title is required")
  } else {
    const lenErr = checkMaxLength(dayTitle, "dayTitle")
    if (lenErr) errors.push(lenErr)
  }

  // Stored as-is in workouts.split (VARCHAR(128)). Absent, null or "" means no split.
  const { split } = req.body
  if (
    split != null &&
    split !== "" &&
    (typeof split !== "string" || split.length > SPLIT_NAME_MAX)
  )
    errors.push(`split must be a string of at most ${SPLIT_NAME_MAX} characters`)

  checkMuscleArray(primaryMuscles, "primaryMuscles", errors)
  checkMuscleArray(secondaryMuscles, "secondaryMuscles", errors)

  // Absent means "not a demo". Anything present but non-boolean is a client
  // bug, not a falsy value to swallow: the route stores `isDemo === true`.
  if (req.body.isDemo !== undefined && typeof req.body.isDemo !== "boolean")
    errors.push("isDemo must be a boolean")

  if (errors.length > 0)
    throw new ValidationError("Invalid session data", errors)
  next()
}

const DEMO_DAYS_MAX = 14
const DEMO_EXERCISES_MAX = 20
const DEMO_SETS_MAX = 10

/**
 * POST /api/sessions/demo. The caps bound the work one request can buy: at most
 * 14 days x 20 exercises x 10 sets per generated workout.
 */
export function validateDemoFill(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const errors: string[] = []
  const { days, split } = req.body
  if (
    split != null &&
    (typeof split !== "string" || !split.trim() || split.length > SPLIT_NAME_MAX)
  )
    errors.push(`split must be a non-empty string of at most ${SPLIT_NAME_MAX} characters`)

  if (!Array.isArray(days) || days.length < 1 || days.length > DEMO_DAYS_MAX) {
    errors.push(`days must be an array of 1-${DEMO_DAYS_MAX} days`)
  } else {
    days.forEach((day: Record<string, unknown>, d: number) => {
      const where = `days[${d}]`
      if (!day || typeof day !== "object") return void errors.push(`${where} must be an object`)
      if (!validateInteger(day.dayNumber) || (day.dayNumber as number) < 1)
        errors.push(`${where}.dayNumber must be a positive integer`)
      if (typeof day.dayTitle !== "string" || !day.dayTitle.trim())
        errors.push(`${where}.dayTitle is required`)
      else if (checkMaxLength(day.dayTitle, "dayTitle"))
        errors.push(`${where}.dayTitle is too long`)
      const exercises = day.exercises
      if (!Array.isArray(exercises) || exercises.length < 1 || exercises.length > DEMO_EXERCISES_MAX)
        return void errors.push(`${where}.exercises must be an array of 1-${DEMO_EXERCISES_MAX} exercises`)
      exercises.forEach((ex: Record<string, unknown>, e: number) => {
        const exWhere = `${where}.exercises[${e}]`
        if (!ex || typeof ex !== "object") return void errors.push(`${exWhere} must be an object`)
        if (typeof ex.name !== "string" || !ex.name.trim() || checkMaxLength(ex.name, "exerciseName"))
          errors.push(`${exWhere}.name must be a non-empty string`)
        if (!validateInteger(ex.sets) || (ex.sets as number) < 1 || (ex.sets as number) > DEMO_SETS_MAX)
          errors.push(`${exWhere}.sets must be an integer from 1 to ${DEMO_SETS_MAX}`)
        checkMuscleArray(ex.primaryMuscles, `${exWhere}.primaryMuscles`, errors)
        checkMuscleArray(ex.secondaryMuscles, `${exWhere}.secondaryMuscles`, errors)
      })
    })
  }

  if (errors.length > 0) throw new ValidationError("Invalid demo data request", errors)
  next()
}

/**
 * Validate the fields of a set timing. Every field is checked only if it is
 * present, so this serves both the create and the partial-update path: the
 * create route runs `validateRequired` ahead of it to demand the mandatory
 * ones. Any field that IS supplied must be well-formed, which is what keeps
 * unvalidated weight/reps/timestamps from reaching the DB via either path.
 */
export function validateSetTiming(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const {
    exerciseName,
    primaryMuscles,
    secondaryMuscles,
    setIndex,
    startTime,
    endTime,
    weight,
    reps,
    note,
    isWarmup,
    machineName,
    rir,
  } = req.body
  const errors: string[] = []

  if (exerciseName !== undefined) {
    if (typeof exerciseName !== "string" || !exerciseName.trim())
      errors.push("Exercise name must be a non-empty string")
    else {
      const lenErr = checkMaxLength(exerciseName, "exerciseName")
      if (lenErr) errors.push(lenErr)
    }
  }
  checkMuscleArray(primaryMuscles, "primaryMuscles", errors)
  checkMuscleArray(secondaryMuscles, "secondaryMuscles", errors)
  if (setIndex !== undefined && (!validateInteger(setIndex) || setIndex < 0))
    errors.push("Set index must be a non-negative integer")
  // parseBackdatedTimestamp, not a bare date parse: `new Date()` accepts 0,
  // true and "2999-01-01", and a phone whose clock is years ahead wrote sets
  // that sorted to the top of every history query forever.
  for (const [field, value] of [
    ["startTime", startTime],
    ["endTime", endTime],
  ] as const) {
    if (value === undefined) continue
    try {
      parseBackdatedTimestamp(value, field)
    } catch (err) {
      errors.push((err as Error).message)
    }
  }
  // ck_ws_weight / ck_ws_reps both allow 0, and the route stores 0 when the
  // field is omitted, so an explicit 0 (a bodyweight set, a failed set) has
  // to be accepted too.
  if (weight != null && (typeof weight !== "number" || isNaN(weight) || weight < 0))
    errors.push("Weight must be a number >= 0")
  if (reps != null && (!validateInteger(reps) || reps < 0))
    errors.push("Reps must be an integer >= 0")
  if (note != null) {
    if (typeof note !== "string") errors.push("Note must be a string")
    else {
      const lenErr = checkMaxLength(note, "note")
      if (lenErr) errors.push(lenErr)
    }
  }
  if (isWarmup !== undefined && typeof isWarmup !== "boolean")
    errors.push("isWarmup must be a boolean")
  // null clears a previous rating, absent leaves it alone. 0 (failure) is a real rating.
  if (rir != null && (!validateInteger(rir) || rir < 0 || rir > 9))
    errors.push("rir must be an integer between 0 and 9")
  // Free text from the user: only the column width matters.
  if (machineName != null) {
    if (typeof machineName !== "string")
      errors.push("machineName must be a string")
    else {
      const lenErr = checkMaxLength(machineName, "machineName")
      if (lenErr) errors.push(lenErr)
    }
  }

  if (errors.length > 0)
    throw new ValidationError("Invalid set timing data", errors)
  next()
}

// ─── Tracking ────────────────────────────────────────────────────────────────

/**
 * An optional free-text note on a tracking entry: null/undefined pass through
 * unchanged (callers differ on whether absent means "leave alone" or "none"),
 * anything else must be a string of at most MAX_LENGTHS.note characters. The
 * columns are TEXT, so without this a note could be a 50 KB essay.
 */
export function requireOptionalNote(
  value: unknown,
  field = "note",
): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== "string")
    throw new ValidationError(`${field} must be a string`)
  if (value.length > MAX_LENGTHS.note)
    throw new ValidationError(
      `${field} must not exceed ${MAX_LENGTHS.note} characters`,
    )
  return value
}

/**
 * An optional list of short strings (menstrual symptoms and the like): null or
 * undefined becomes [], anything else must be an array of at most `maxItems`
 * strings, each at most `maxLength` characters.
 */
export function requireStringList(
  value: unknown,
  field: string,
  { maxItems, maxLength }: { maxItems: number; maxLength: number },
): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string"))
    throw new ValidationError(`${field} must be an array of strings`)
  if (value.length > maxItems)
    throw new ValidationError(`${field} must have at most ${maxItems} items`)
  if (value.some((s: string) => s.length > maxLength))
    throw new ValidationError(`each of ${field} must be at most ${maxLength} characters`)
  return value as string[]
}

// ─── Programs ────────────────────────────────────────────────────────────────

/**
 * Structural caps on a program. An upload is unpacked row by row inside one
 * transaction, so without these a 2 MB body of ~70k minimal days held a pool
 * connection and its locks for minutes. Each cap is far above any real
 * program. They only bound the work one request can buy.
 */
export const PROGRAM_LIMITS = {
  days: 31,
  dayNumber: 1000,
  /** Split names, both in weeklyPlan.split and per day. */
  splits: 20,
  exercisesPerSplit: 50,
  /** Exercise slots across the whole upload. */
  slots: 1500,
  /** Distinct exercise names across the whole upload. */
  distinctNames: 500,
  sets: 100,
  filename: 255,
  reps: 32, // program_exercises.target_reps
  catalogId: 64, // program_exercises.catalog_id
  machines: 20,
  machineMetaKeys: 20,
  machineMetaFields: 10,
  machineText: 200,
} as const

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * A client-supplied integer, accepted as a number or a digit string (clients
 * that read it from a spreadsheet send either). Returns undefined when the
 * value is not one.
 */
function asInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v
  if (typeof v === "string" && /^-?\d{1,9}$/.test(v.trim())) return Number(v)
  return undefined
}

const isSplitName = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= SPLIT_NAME_MAX

const isShortString = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max

/**
 * The machine sub-fields of a program exercise (MACHINE_FIELDS in
 * programs.model). `null` is allowed on every key: JSON_MERGE_PATCH reads it
 * as "clear this setting", and an upload stores it as given.
 */
function checkMachineFields(
  ex: Record<string, unknown>,
  where: string,
  errors: string[],
): void {
  const L = PROGRAM_LIMITS
  const { machines, selectedMachine, defaultMachine, bestAcrossMachines, machineMeta } = ex
  if (
    machines != null &&
    !(
      Array.isArray(machines) &&
      machines.length <= L.machines &&
      machines.every((m) => isShortString(m, MAX_LENGTHS.machineName))
    )
  )
    errors.push(
      `${where}.machines must be an array of at most ${L.machines} strings (max ${MAX_LENGTHS.machineName} chars each)`,
    )
  for (const [k, v] of [
    ["selectedMachine", selectedMachine],
    ["defaultMachine", defaultMachine],
  ] as const)
    if (v != null && !isShortString(v, MAX_LENGTHS.machineName))
      errors.push(`${where}.${k} must be a string of at most ${MAX_LENGTHS.machineName} characters`)
  if (bestAcrossMachines != null && typeof bestAcrossMachines !== "boolean")
    errors.push(`${where}.bestAcrossMachines must be a boolean`)
  if (machineMeta != null) {
    const entries = isPlainObject(machineMeta) ? Object.entries(machineMeta) : null
    const ok =
      entries !== null &&
      entries.length <= L.machineMetaKeys &&
      entries.every(
        ([name, meta]) =>
          name.length <= MAX_LENGTHS.machineName &&
          (meta === null ||
            (isPlainObject(meta) &&
              Object.keys(meta).length <= L.machineMetaFields &&
              Object.values(meta).every(
                (x) =>
                  x === null ||
                  typeof x === "boolean" ||
                  typeof x === "number" ||
                  isShortString(x, L.machineText),
              ))),
      )
    if (!ok)
      errors.push(
        `${where}.machineMeta must map at most ${L.machineMetaKeys} machine names to objects of short values (max ${L.machineText} chars)`,
      )
  }
}

/** Fields shared by an uploaded exercise and PATCH /exercise/add's `exercise`. */
function checkProgramExercise(
  ex: Record<string, unknown>,
  where: string,
  errors: string[],
): void {
  const L = PROGRAM_LIMITS
  if (
    typeof ex.name !== "string" ||
    !ex.name.trim() ||
    ex.name.length > MAX_LENGTHS.exerciseName
  )
    errors.push(
      `${where}.name must be a non-empty string of at most ${MAX_LENGTHS.exerciseName} characters`,
    )
  if (ex.sets != null) {
    const sets = typeof ex.sets === "number" ? ex.sets : asInt(ex.sets)
    if (sets === undefined || !Number.isFinite(sets) || sets < 0 || sets > L.sets)
      errors.push(`${where}.sets must be a number between 0 and ${L.sets}`)
  }
  if (
    ex.reps != null &&
    !isShortString(ex.reps, L.reps) &&
    !(typeof ex.reps === "number" && Number.isFinite(ex.reps))
  )
    errors.push(`${where}.reps must be a string of at most ${L.reps} characters`)
  if (ex.exerciseId != null && !isShortString(ex.exerciseId, L.catalogId))
    errors.push(`${where}.exerciseId must be a string of at most ${L.catalogId} characters`)
  checkMuscleArray(ex.primaryMuscles, `${where}.primaryMuscles`, errors)
  checkMuscleArray(ex.secondaryMuscles, `${where}.secondaryMuscles`, errors)
  checkMachineFields(ex, where, errors)
}

/** Stop collecting after this many problems, since the client needs the first few. */
const MAX_REPORTED_ERRORS = 20

/**
 * POST /api/program/upload. Checks every type and cap before the model opens
 * its transaction, so a hostile or broken payload costs a walk over the parsed
 * JSON rather than a pool connection. Coerces digit-string dayNumbers to
 * numbers in place, so the model's duplicate-day check compares like with like.
 */
export function validateProgramUpload(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const L = PROGRAM_LIMITS
  const { weeklyPlan, originalFilename } = req.body ?? {}

  if (
    !isPlainObject(weeklyPlan) ||
    !Array.isArray(weeklyPlan.days) ||
    !Array.isArray(weeklyPlan.split)
  )
    throw new ValidationError("weeklyPlan with days[] and split[] is required")
  if (!originalFilename || typeof originalFilename !== "string")
    throw new ValidationError("originalFilename is required")
  if (originalFilename.length > L.filename)
    throw new ValidationError(`originalFilename must not exceed ${L.filename} characters`)

  const days: unknown[] = weeklyPlan.days
  const split: unknown[] = weeklyPlan.split
  // Counts first, before walking anything.
  if (days.length > L.days)
    throw new ValidationError(`A program may have at most ${L.days} days`)
  if (split.length > L.splits || !split.every(isSplitName))
    throw new ValidationError(
      `split must be an array of at most ${L.splits} non-empty strings (max ${SPLIT_NAME_MAX} chars each)`,
    )

  const errors: string[] = []
  const names = new Set<string>()
  let slots = 0

  for (const [i, day] of days.entries()) {
    if (errors.length >= MAX_REPORTED_ERRORS) break
    const where = `days[${i}]`
    if (!isPlainObject(day)) {
      errors.push(`${where} must be an object`)
      continue
    }
    const dayNumber = asInt(day.dayNumber)
    if (dayNumber === undefined || dayNumber < 1 || dayNumber > L.dayNumber)
      errors.push(`${where}.dayNumber must be an integer between 1 and ${L.dayNumber}`)
    else day.dayNumber = dayNumber
    if (day.dayTitle != null && !isShortString(day.dayTitle, MAX_LENGTHS.dayTitle))
      errors.push(`${where}.dayTitle must be a string of at most ${MAX_LENGTHS.dayTitle} characters`)
    checkMuscleArray(day.primaryMuscles, `${where}.primaryMuscles`, errors)
    checkMuscleArray(day.secondaryMuscles, `${where}.secondaryMuscles`, errors)
    // The flat per-day list is derived data the server never stores, but the
    // upload response echoes it back.
    if (
      day.exercises != null &&
      !(Array.isArray(day.exercises) && day.exercises.length <= L.slots)
    )
      errors.push(`${where}.exercises must be an array of at most ${L.slots} entries`)

    if (day.split == null) continue
    if (!isPlainObject(day.split)) {
      errors.push(`${where}.split must be an object keyed by split name`)
      continue
    }
    const splits = Object.entries(day.split)
    if (splits.length > L.splits) {
      errors.push(`${where}.split may have at most ${L.splits} splits`)
      continue
    }
    for (const [splitName, sw] of splits) {
      const sWhere = `${where}.split[${JSON.stringify(splitName.slice(0, 40))}]`
      if (!isSplitName(splitName)) {
        errors.push(`${sWhere}: split names must be 1-${SPLIT_NAME_MAX} characters`)
        continue
      }
      if (!isPlainObject(sw)) {
        errors.push(`${sWhere} must be an object`)
        continue
      }
      if (sw.exercises == null) continue
      if (!Array.isArray(sw.exercises) || sw.exercises.length > L.exercisesPerSplit) {
        errors.push(`${sWhere}.exercises must be an array of at most ${L.exercisesPerSplit} exercises`)
        continue
      }
      slots += sw.exercises.length
      if (slots > L.slots)
        throw new ValidationError(`A program may have at most ${L.slots} exercise slots in total`)
      for (const [j, ex] of sw.exercises.entries()) {
        const eWhere = `${sWhere}.exercises[${j}]`
        if (!isPlainObject(ex)) {
          errors.push(`${eWhere} must be an object`)
          continue
        }
        checkProgramExercise(ex, eWhere, errors)
        if (typeof ex.name === "string") names.add(ex.name.trim().toLowerCase())
      }
    }
  }
  if (names.size > L.distinctNames)
    errors.push(`A program may name at most ${L.distinctNames} distinct exercises`)

  if (errors.length > 0)
    throw new ValidationError("Invalid program", errors.slice(0, MAX_REPORTED_ERRORS))
  next()
}

/**
 * Shape checks for the PATCH /api/program/exercise/* routes: every field that
 * is present must be well-typed. Presence is still each route's own check.
 * Digit-string dayNumber / exerciseIndex are coerced to numbers in place.
 */
export function validateProgramExercisePatch(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const L = PROGRAM_LIMITS
  const b = req.body ?? {}
  const errors: string[] = []

  if (b.dayNumber != null) {
    const n = asInt(b.dayNumber)
    if (n === undefined || n < 1 || n > L.dayNumber)
      errors.push(`dayNumber must be an integer between 1 and ${L.dayNumber}`)
    else b.dayNumber = n
  }
  if (b.exerciseIndex != null) {
    const n = asInt(b.exerciseIndex)
    if (n === undefined || n < 0 || n >= L.exercisesPerSplit * 10)
      errors.push("exerciseIndex must be a non-negative integer")
    else b.exerciseIndex = n
  }
  if (b.split != null && !isSplitName(b.split))
    errors.push(`split must be a non-empty string of at most ${SPLIT_NAME_MAX} characters`)
  if (
    b.newName != null &&
    (typeof b.newName !== "string" || b.newName.length > MAX_LENGTHS.exerciseName)
  )
    errors.push(`newName must be a string of at most ${MAX_LENGTHS.exerciseName} characters`)
  checkMuscleArray(b.newPrimaryMuscles, "newPrimaryMuscles", errors)
  checkMuscleArray(b.newSecondaryMuscles, "newSecondaryMuscles", errors)
  if (b.newExerciseId != null && !isShortString(b.newExerciseId, L.catalogId))
    errors.push(`newExerciseId must be a string of at most ${L.catalogId} characters`)
  if (b.additionalSets != null) {
    const n = asInt(b.additionalSets)
    if (n === undefined || Math.abs(n) > L.sets)
      errors.push(`additionalSets must be an integer between -${L.sets} and ${L.sets}`)
    else b.additionalSets = n
  }
  if (b.exercise != null) {
    if (!isPlainObject(b.exercise)) errors.push("exercise must be an object")
    else checkProgramExercise(b.exercise, "exercise", errors)
  }
  if (b.patch != null) {
    if (!isPlainObject(b.patch)) errors.push("patch must be an object")
    else checkMachineFields(b.patch, "patch", errors)
  }

  if (errors.length > 0)
    throw new ValidationError("Invalid program edit", errors)
  next()
}

/**
 * `?muscle=` on the tracking list routes (injuries, soreness): undefined when
 * absent, otherwise a non-empty muscle group name of at most 64 characters.
 */
export function listMuscleFilter(req: Request): string | undefined {
  const raw = req.query.muscle
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || !raw.trim() || raw.length > 64)
    throw new ValidationError("muscle must be a muscle group name")
  return raw.trim()
}

/** `?status=active` on the same routes. Any other value is a 400. */
export function listActiveFilter(req: Request): boolean {
  const raw = req.query.status
  if (raw === undefined) return false
  if (raw !== "active") throw new ValidationError('status must be "active"')
  return true
}
