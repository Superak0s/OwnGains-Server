// The workout program, relationally.
//
// This used to be one `workout_programs.program_data` JSON blob per user: every
// edit read the whole program into Node, mutated an object, and wrote the whole
// thing back, and the exercise names in it had no connection to the `exercises`
// catalog every recorded set already pointed at. Now a program is
// programs → program_days → program_exercises → exercises, and a rename or a
// set-count change is an UPDATE of one row.
//
// GET /api/program still returns exactly the shape the app has always read.
// toProgramData below is where the rows become that shape again.

import { pool, withTransaction } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import {
  NotFoundError,
  ValidationError,
  throwCheckViolation,
} from "@/middleware/errorHandler.js"
import {
  findOrCreateExercise,
  findProgramDayId,
  parseMuscleGroups as asStrings,
} from "@/features/workouts/workouts.model.js"
import { PROGRAM_LIMITS } from "@/middleware/validation.js"
import type {
  Exercise,
  MachineFields,
  ProgramDay,
  ProgramData,
  StoredProgram,
} from "./programs.types.js"

/** The only exercise keys patchExerciseMachine will write. */
export const MACHINE_FIELDS = [
  "machines",
  "selectedMachine",
  "defaultMachine",
  "bestAcrossMachines",
  "machineMeta",
] as const satisfies readonly (keyof MachineFields)[]

/**
 * Every key an uploaded exercise may include. Anything else is rejected rather
 * than dropped: the old behaviour discarded unrecognised keys silently, so a
 * client sending a field the server had never heard of got a 200 and no data.
 */
const EXERCISE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "primaryMuscles",
  "secondaryMuscles",
  "sets",
  "reps",
  "exerciseId",
  // Legacy: superseded by exerciseId = CUSTOM_EXERCISE_ID, but programs saved
  // before that still store it on device and the app's migration doesn't strip
  // it, so rejecting it would 400 a re-upload of an older program.
  "custom",
  ...MACHINE_FIELDS,
])

/** Case-insensitive catalog key: `exercises.name` is utf8mb4_unicode_ci. */
const catalogKey = (name: string): string => name.trim().toLowerCase()

// ─── Read ─────────────────────────────────────────────────────────────────────

interface ProgramRow extends RowDataPacket {
  id: number
  originalFilename: string
  splitOrder: unknown
  uploadedAt: string
  currentDay: number | null
}

interface DayRow extends RowDataPacket {
  id: number
  dayNumber: number
  dayTitle: string
  primaryMuscles: unknown
  secondaryMuscles: unknown
}

interface SlotRow extends RowDataPacket {
  programDayId: number
  splitName: string
  position: number
  name: string
  primaryMuscles: unknown
  secondaryMuscles: unknown
  exerciseId: string | null
  sets: number
  reps: string | null
  machine: Record<string, unknown> | null
}

export async function getProgramByUserId(
  userId: number,
): Promise<StoredProgram | null> {
  const [programs] = await pool.execute<ProgramRow[]>(
    `SELECT id, original_filename AS originalFilename,
            split_order AS splitOrder, uploaded_at AS uploadedAt,
            current_day AS currentDay
     FROM programs WHERE user_id = ?`,
    [userId],
  )
  const program = programs[0]
  if (!program) return null

  const [[days], [slots]] = await Promise.all([
    pool.execute<DayRow[]>(
      `SELECT id, day_number AS dayNumber, title AS dayTitle,
              primary_muscles AS primaryMuscles,
              secondary_muscles AS secondaryMuscles
       FROM program_days WHERE program_id = ? ORDER BY day_number ASC`,
      [program.id],
    ),
    pool.execute<SlotRow[]>(
      `SELECT pe.program_day_id AS programDayId, pe.split_name AS splitName,
              pe.position, e.name,
              IF(JSON_LENGTH(uem.primary_muscles) > 0,
                 uem.primary_muscles, e.primary_muscles) AS primaryMuscles,
              IF(JSON_LENGTH(uem.secondary_muscles) > 0,
                 uem.secondary_muscles, e.secondary_muscles) AS secondaryMuscles,
              pe.catalog_id AS exerciseId, pe.target_sets AS sets,
              pe.target_reps AS reps, pe.machine
       FROM program_exercises pe
       JOIN program_days pd ON pd.id = pe.program_day_id
       JOIN exercises e ON e.id = pe.exercise_id
       LEFT JOIN user_exercise_muscles uem
         ON uem.user_id = ? AND uem.exercise_id = pe.exercise_id
       WHERE pd.program_id = ?
       ORDER BY pe.split_name ASC, pe.position ASC`,
      [userId, program.id],
    ),
  ])

  return {
    programData: toProgramData(program, days, slots),
    originalFilename: program.originalFilename,
    uploadedAt: program.uploadedAt,
    currentDay: program.currentDay ?? null,
  }
}

/** Rows → the JSON the app has always received. */
function toProgramData(
  program: ProgramRow,
  days: DayRow[],
  slots: SlotRow[],
): ProgramData {
  const byDay = new Map<number, SlotRow[]>()
  for (const slot of slots) {
    const list = byDay.get(slot.programDayId)
    if (list) list.push(slot)
    else byDay.set(slot.programDayId, [slot])
  }

  // Slots come back ordered by split_name so the per-day grouping is stable,
  // which alphabetised every day's split keys. The program's own split_order is
  // the upload's order, so re-key each day through it instead of storing the
  // order a second time per day.
  const splitOrder = asStrings(program.splitOrder)
  const bySplitOrder = (a: string, b: string): number => {
    const ia = splitOrder.indexOf(a)
    const ib = splitOrder.indexOf(b)
    if (ia !== ib)
      return (ia < 0 ? splitOrder.length : ia) - (ib < 0 ? splitOrder.length : ib)
    return a.localeCompare(b)
  }

  return {
    split: splitOrder,
    days: days.map((day): ProgramDay => {
      const daySlots = byDay.get(day.id) ?? []
      const unordered: ProgramDay["split"] = {}
      // Flat list, in first-seen order, with the per-split set counts the day
      // view reads. Derived here rather than stored twice.
      const flat = new Map<string, ProgramDay["exercises"][number]>()

      for (const slot of daySlots) {
        const exercise: Exercise = {
          name: slot.name,
          primaryMuscles: asStrings(slot.primaryMuscles),
          secondaryMuscles: asStrings(slot.secondaryMuscles),
          sets: slot.sets,
          ...(slot.reps ? { reps: slot.reps } : {}),
          exerciseId: slot.exerciseId,
          ...slot.machine,
        }
        const sw = (unordered[slot.splitName] ??= {
          exercises: [],
          totalSets: 0,
        })
        sw.exercises.push(exercise)
        sw.totalSets += slot.sets

        const seen = flat.get(slot.name)
        if (seen) seen.setsBySplit[slot.splitName] = slot.sets
        else
          flat.set(slot.name, {
            name: slot.name,
            primaryMuscles: exercise.primaryMuscles!,
            secondaryMuscles: exercise.secondaryMuscles!,
            ...(slot.reps ? { reps: slot.reps } : {}),
            exerciseId: slot.exerciseId,
            setsBySplit: { [slot.splitName]: slot.sets },
          })
      }

      const split: ProgramDay["split"] = {}
      for (const name of Object.keys(unordered).sort(bySplitOrder))
        split[name] = unordered[name]

      return {
        dayNumber: day.dayNumber,
        dayTitle: day.dayTitle,
        primaryMuscles: asStrings(day.primaryMuscles),
        secondaryMuscles: asStrings(day.secondaryMuscles),
        exercises: [...flat.values()],
        split,
      }
    }),
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Catalog ids for every name in one round trip, creating the rows that don't
 * exist yet.
 *
 * The returned map is keyed case-insensitively, because `exercises.name` is
 * utf8mb4_unicode_ci: an upload saying "Bench Press" against a stored
 * "bench press" gets the stored spelling back from the SELECT, and keying on
 * the payload's spelling left the lookup undefined, which mysql2 rejects, so
 * the whole upload 500'd on a casing difference.
 *
 * Muscle groups never reach the catalog: its labels are every other user's
 * fallback (same rule as findOrCreateExercise). The uploader's own labels go
 * to user_exercise_muscles.
 */
async function catalogIds(
  exercises: Map<
    string,
    { name: string; primaryMuscles: string[]; secondaryMuscles: string[] }
  >,
): Promise<Map<string, number>> {
  const names = [...exercises.keys()].sort()
  if (!names.length) return new Map()

  // Autocommit on the pool, before the upload's transaction opens. Inside it,
  // these shared rows stayed locked until commit, so two users uploading
  // overlapping exercise names deadlocked and one got a 503. A row left behind
  // by a failed upload is harmless (it is only a name). Sorted so concurrent
  // batches take their locks in the same order. Account deletion pruning a row
  // in the gap before the transaction uses it is the race auth.model.ts
  // already accepts for findOrCreateExercise.
  await pool.execute(
    `INSERT INTO exercises (name) VALUES ${names.map(() => "(?)").join(", ")}
     ON DUPLICATE KEY UPDATE id = id`,
    names.map((name) => exercises.get(name)!.name),
  )

  const [rows] = await pool.execute<
    (RowDataPacket & { id: number; name: string })[]
  >(
    `SELECT id, name FROM exercises WHERE name IN (${names.map(() => "?").join(", ")})`,
    names.map((n) => exercises.get(n)!.name),
  )
  return new Map(rows.map((r) => [catalogKey(r.name), r.id]))
}

/** The uploader's muscle labels, inside the upload's transaction. */
async function saveUploadMuscles(
  connection: PoolConnection,
  userId: number,
  exercises: Map<
    string,
    { name: string; primaryMuscles: string[]; secondaryMuscles: string[] }
  >,
  ids: Map<string, number>,
): Promise<void> {
  // The uploader's labels become their own (user_exercise_muscles), whatever
  // the catalog already held. Upload is rare, so this is one unconditional
  // upsert rather than saveOwnMuscles' compare-first dance.
  const labelled = [...exercises.entries()].filter(
    ([, e]) => e.primaryMuscles.length || e.secondaryMuscles.length,
  )
  if (labelled.length)
    await connection.query(
      `INSERT INTO user_exercise_muscles
         (user_id, exercise_id, primary_muscles, secondary_muscles)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         primary_muscles = IF(JSON_LENGTH(VALUES(primary_muscles)) > 0,
                              VALUES(primary_muscles), primary_muscles),
         secondary_muscles = IF(JSON_LENGTH(VALUES(secondary_muscles)) > 0,
                                VALUES(secondary_muscles), secondary_muscles)`,
      [
        labelled.map(([key, e]) => [
          userId,
          ids.get(key)!,
          JSON.stringify(e.primaryMuscles),
          JSON.stringify(e.secondaryMuscles),
        ]),
      ],
    )
}

/**
 * Replace the caller's program with this one. Days are upserted on
 * (program_id, day_number) rather than deleted and recreated, so a workout's
 * program_day_id is kept across a re-upload of the same day and its history keeps its
 * muscle labels.
 */
export async function upsertProgram(
  userId: number,
  programData: ProgramData,
  originalFilename: string,
): Promise<void> {
  const days = programData.days ?? []

  // Two entries with the same dayNumber upsert onto the same row, and the
  // second one's unconditional DELETE wipes the exercises the first just
  // wrote: a 200 that silently emptied a day.
  const seenDays = new Set<number>()
  for (const day of days) {
    if (seenDays.has(day.dayNumber))
      throw new ValidationError(`Duplicate dayNumber ${day.dayNumber}`)
    seenDays.add(day.dayNumber)
  }

  // Every exercise named anywhere in the upload, with the best muscle groups
  // the payload offers for it. Keyed case-insensitively to match the catalog's
  // collation, so "Bench Press" and "bench press" in one upload are one entry.
  const catalog = new Map<
    string,
    { name: string; primaryMuscles: string[]; secondaryMuscles: string[] }
  >()
  for (const ex of uploadExercises(days)) {
    const name = ex.name?.trim()
    if (!name) throw new ValidationError("Every exercise needs a name")
    const unknown = Object.keys(ex).filter((k) => !EXERCISE_KEYS.has(k))
    if (unknown.length)
      throw new ValidationError(
        `Unknown key(s) on an exercise: ${unknown.join(", ")}`,
      )
    if (ex.sets != null && !Number.isFinite(Number(ex.sets)))
      throw new ValidationError("sets must be a number")
    const existing = catalog.get(catalogKey(name))
    catalog.set(catalogKey(name), {
      name,
      primaryMuscles: ex.primaryMuscles?.length
        ? ex.primaryMuscles
        : (existing?.primaryMuscles ?? []),
      secondaryMuscles: ex.secondaryMuscles?.length
        ? ex.secondaryMuscles
        : (existing?.secondaryMuscles ?? []),
    })
  }

  const ids = await catalogIds(catalog)

  await withTransaction(async (connection) => {
    const [programResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO programs (user_id, original_filename, split_order)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id),
         original_filename = VALUES(original_filename),
         split_order = VALUES(split_order), uploaded_at = NOW()`,
      [userId, originalFilename, JSON.stringify(programData.split ?? [])],
    )
    const programId = programResult.insertId
    await saveUploadMuscles(connection, userId, catalog, ids)

    // A fixed number of statements whatever the program's size (the route's
    // validator caps that size too): one upsert for every day, one read of
    // their ids, one delete of the old slots and one insert of the new ones.
    // It used to be three statements per day inside this transaction.
    if (days.length) {
      await connection.execute(
        `INSERT INTO program_days
           (program_id, day_number, title, primary_muscles, secondary_muscles)
         VALUES ${days.map(() => "(?, ?, ?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE title = VALUES(title),
           primary_muscles = VALUES(primary_muscles),
           secondary_muscles = VALUES(secondary_muscles)`,
        days.flatMap((day) => [
          programId,
          day.dayNumber,
          day.dayTitle ?? "",
          JSON.stringify(day.primaryMuscles ?? []),
          JSON.stringify(day.secondaryMuscles ?? []),
        ]),
      )
    }
    const [dayRows] = await connection.execute<
      (RowDataPacket & { id: number; dayNumber: number })[]
    >(
      `SELECT id, day_number AS dayNumber FROM program_days WHERE program_id = ?`,
      [programId],
    )
    const dayIds = new Map(dayRows.map((r) => [r.dayNumber, r.id]))

    // The slots themselves are disposable (nothing references them), so the
    // simple thing is right: clear the program's slots and write what was
    // uploaded. Dropped days' slots go with their day below.
    await connection.execute(
      `DELETE pe FROM program_exercises pe
       JOIN program_days pd ON pd.id = pe.program_day_id
       WHERE pd.program_id = ?`,
      [programId],
    )

    const slots: (string | number | null)[][] = []
    for (const day of days)
      for (const [splitName, sw] of Object.entries(day.split ?? {}))
        for (const [position, ex] of (sw.exercises ?? []).entries())
          slots.push([
            dayIds.get(day.dayNumber)!,
            splitName,
            position,
            ids.get(catalogKey(ex.name))!,
            ex.exerciseId?.trim() || null,
            Number(ex.sets) || 0,
            // Free text. A spreadsheet cell may arrive as a number.
            ex.reps == null ? null : String(ex.reps).trim() || null,
            JSON.stringify(machineOf(ex)),
          ])
    if (slots.length)
      await connection.execute(
        `INSERT INTO program_exercises
           (program_day_id, split_name, position, exercise_id, catalog_id,
            target_sets, target_reps, machine)
         VALUES ${slots.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
        slots.flat(),
      )

    // Days the upload dropped. ON DELETE SET NULL on workouts.program_day_id
    // means their history is kept, unlabelled.
    await connection.execute(
      days.length
        ? `DELETE FROM program_days WHERE program_id = ?
             AND day_number NOT IN (${days.map(() => "?").join(", ")})`
        : `DELETE FROM program_days WHERE program_id = ?`,
      [programId, ...days.map((d) => d.dayNumber)],
    )

    // ...and neither must the day pointer. Re-uploading a 4-day program over a
    // 7-day one left current_day = 7, so the client opened a day that no longer
    // exists and logged a permanently unlabelled workout.
    await connection.execute(
      days.length
        ? `UPDATE programs SET current_day = NULL WHERE id = ?
             AND current_day IS NOT NULL
             AND current_day NOT IN (${days.map(() => "?").join(", ")})`
        : `UPDATE programs SET current_day = NULL WHERE id = ?`,
      [programId, ...days.map((d) => d.dayNumber)],
    )
  })
}

/** Every exercise of every split of every day, in upload order. */
function uploadExercises(days: NonNullable<ProgramData["days"]>): Exercise[] {
  return days.flatMap((day) =>
    Object.values(day.split ?? {}).flatMap((sw) => sw.exercises ?? []),
  )
}

/** The machine sub-object of an exercise, separated from its program fields. */
function machineOf(exercise: Exercise): Record<string, unknown> {
  return Object.fromEntries(
    MACHINE_FIELDS.filter((k) => exercise[k] !== undefined).map((k) => [
      k,
      exercise[k],
    ]),
  )
}

export async function deleteProgramByUserId(userId: number): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM programs WHERE user_id = ?`,
    [userId],
  )
  return result.affectedRows > 0
}

/**
 * The user's current day pointer. `null` both when there is no program and
 * when one exists but no day was ever set. The client treats the two the
 * same (it falls back to its local pointer), so they need no distinction here.
 */
export async function getProgramCurrentDay(
  userId: number,
): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT current_day FROM programs WHERE user_id = ?`,
    [userId],
  )
  return rows[0]?.current_day ?? null
}

/**
 * Throws rather than inserting when the user has no program: a day pointer
 * into a program that doesn't exist points at nothing, and an upsert here
 * would create a program row with no days behind the caller's back.
 */
export async function setProgramCurrentDay(
  userId: number,
  currentDay: number,
): Promise<void> {
  // Existence is checked separately rather than read off affectedRows: MySQL
  // counts rows *changed*, not matched, so re-setting the day the user is
  // already on would otherwise look like "no such program" and 404. The day
  // has to exist too, otherwise the client happily starts a workout for a
  // day the program doesn't have. One read answers both.
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT p.id, pd.id AS dayId
     FROM programs p
     LEFT JOIN program_days pd ON pd.program_id = p.id AND pd.day_number = ?
     WHERE p.user_id = ?`,
    [currentDay, userId],
  )
  if (!rows.length) throw new NotFoundError("Program")
  if (rows[0].dayId == null) throw new NotFoundError(`Day ${currentDay}`)

  await pool.execute(`UPDATE programs SET current_day = ? WHERE user_id = ?`, [
    currentDay,
    userId,
  ])
}

// ─── Targeted edits ───────────────────────────────────────────────────────────

interface SlotIdRow extends RowDataPacket {
  id: number
  programDayId: number
  name: string
  sets: number
}

/**
 * The one program_exercises row a client addresses by (day, split, index), with
 * ownership proved by the join back to programs.user_id.
 */
async function requireSlot(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
): Promise<SlotIdRow> {
  const [rows] = await pool.execute<SlotIdRow[]>(
    `SELECT pe.id, pe.program_day_id AS programDayId, e.name,
            pe.target_sets AS sets
     FROM program_exercises pe
     JOIN program_days pd ON pd.id = pe.program_day_id
     JOIN programs p ON p.id = pd.program_id
     JOIN exercises e ON e.id = pe.exercise_id
     WHERE p.user_id = ? AND pd.day_number = ? AND pe.split_name = ?
       AND pe.position = ?`,
    [userId, dayNumber, split, exerciseIndex],
  )
  if (!rows[0]) throw new NotFoundError("Exercise")
  return rows[0]
}

async function requireDayId(userId: number, dayNumber: number): Promise<number> {
  const id = await findProgramDayId(userId, dayNumber)
  if (id == null) throw new NotFoundError(`Day ${dayNumber}`)
  return id
}

export async function renameExercise(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  rename: {
    newName: string
    newPrimaryMuscles?: string[]
    newSecondaryMuscles?: string[]
    newExerciseId?: string | null
  },
): Promise<{ oldName: string; newName: string; exerciseIndex: number }> {
  const { newName, newPrimaryMuscles, newSecondaryMuscles, newExerciseId } = rename
  const slot = await requireSlot(userId, dayNumber, split, exerciseIndex)
  const trimmed = newName.trim()
  const exerciseId = await findOrCreateExercise(
    userId,
    trimmed,
    newPrimaryMuscles,
    newSecondaryMuscles,
  )

  await pool.execute(
    // Absent newExerciseId leaves the stored catalog id alone. Explicit null
    // clears it, which is how a matched exercise becomes a custom one again.
    newExerciseId === undefined
      ? `UPDATE program_exercises SET exercise_id = ? WHERE id = ?`
      : `UPDATE program_exercises SET exercise_id = ?, catalog_id = ? WHERE id = ?`,
    newExerciseId === undefined
      ? [exerciseId, slot.id]
      : [exerciseId, newExerciseId?.trim() || null, slot.id],
  )
  return { oldName: slot.name, newName: trimmed, exerciseIndex }
}

export async function addExercise(
  userId: number,
  dayNumber: number,
  split: string,
  exercise: {
    name?: string
    sets?: number
    primaryMuscles?: string[]
    secondaryMuscles?: string[]
    reps?: string
    exerciseId?: string | null
  },
): Promise<{ exerciseIndex: number; exercise: Exercise }> {
  if (!exercise?.name || !exercise?.sets)
    throw new ValidationError("Exercise name and sets are required")
  const sets = Number(exercise.sets)
  if (!Number.isInteger(sets) || sets < 0)
    throw new ValidationError("sets must be a non-negative integer")

  const dayId = await requireDayId(userId, dayNumber)

  // Same caps as an upload: split_order used to grow by one entry per new
  // split name, forever.
  const [[order]] = await pool.execute<RowDataPacket[]>(
    `SELECT JSON_CONTAINS(split_order, JSON_QUOTE(?)) AS listed,
            JSON_LENGTH(split_order) AS count
     FROM programs WHERE user_id = ?`,
    [split, userId],
  )
  if (!order.listed && order.count >= PROGRAM_LIMITS.splits)
    throw new ValidationError(
      `A program may have at most ${PROGRAM_LIMITS.splits} splits`,
    )

  const name = exercise.name.trim()
  const catalogRowId = await findOrCreateExercise(
    userId,
    name,
    exercise.primaryMuscles,
    exercise.secondaryMuscles,
  )

  // The position is computed inside the INSERT, but at READ COMMITTED two
  // concurrent adds still read the same MAX and the loser hits uq_pe_slot: a
  // phone and a tablet adding to the same split at once. One retry is enough:
  // by then the winner's row is committed and MAX has moved.
  const reps = exercise.reps == null ? null : String(exercise.reps).trim() || null
  const catalogId = exercise.exerciseId?.trim() || null
  const insertSlot = () =>
    pool.execute<ResultSetHeader>(
      `INSERT INTO program_exercises
         (program_day_id, split_name, position, exercise_id, catalog_id,
          target_sets, target_reps)
       SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ?, ?
       FROM program_exercises
       WHERE program_day_id = ? AND split_name = ?
       HAVING COUNT(*) < ?`,
      [
        dayId,
        split,
        catalogRowId,
        catalogId,
        sets,
        reps,
        dayId,
        split,
        PROGRAM_LIMITS.exercisesPerSplit,
      ],
    )
  let inserted: ResultSetHeader
  try {
    ;[inserted] = await insertSlot()
  } catch (err) {
    if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err
    ;[inserted] = await insertSlot()
  }
  // HAVING filtered the one aggregate row out: the split is full.
  if (inserted.affectedRows === 0)
    throw new ValidationError(
      `A split may have at most ${PROGRAM_LIMITS.exercisesPerSplit} exercises`,
    )
  const [[insertedRow]] = await pool.execute<
    (RowDataPacket & { position: number })[]
  >(`SELECT position FROM program_exercises WHERE id = ?`, [inserted.insertId])
  const position = insertedRow.position

  // A split the program didn't list yet: append it, without rewriting the
  // array in Node.
  await pool.execute(
    `UPDATE programs SET split_order = JSON_ARRAY_APPEND(split_order, '$', ?)
     WHERE user_id = ? AND NOT JSON_CONTAINS(split_order, JSON_QUOTE(?))`,
    [split, userId, split],
  )

  return {
    exerciseIndex: position,
    exercise: {
      name,
      primaryMuscles: exercise.primaryMuscles ?? [],
      secondaryMuscles: exercise.secondaryMuscles ?? [],
      sets,
      // Free text ("10", "8-12", even "0"), stored as given, or omitted when
      // absent. Never a validation failure.
      ...(reps ? { reps } : {}),
      exerciseId: catalogId,
    },
  }
}

/**
 * Targeted machine-settings patch. Exists so trainer mode has a way to change a
 * trainee's machine setup without `POST /program/upload`, which is a whole-
 * program replace and so needs `denyTrainer`. Only the keys in
 * MACHINE_FIELDS are merged, so this cannot rewrite names, sets, or anything
 * else in the program.
 */
export async function patchExerciseMachine(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  patch: MachineFields,
): Promise<{ exerciseIndex: number }> {
  const slot = await requireSlot(userId, dayNumber, split, exerciseIndex)

  // JSON_MERGE_PATCH drops a key whose new value is null, which is how the app
  // clears a setting, and an absent key is left alone. JSON.stringify would drop an
  // explicit undefined entirely, so map it to null first.
  const merge = JSON.stringify(
    Object.fromEntries(
      MACHINE_FIELDS.filter((k) => k in patch).map((k) => [k, patch[k] ?? null]),
    ),
  )
  // The validator caps one patch. Merging many of them could still grow
  // machineMeta without bound, so the cap applies to the merged result. The
  // guard rides in the UPDATE itself so two concurrent patches can't both
  // squeeze under it.
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE program_exercises SET machine = JSON_MERGE_PATCH(machine, ?)
     WHERE id = ?
       AND COALESCE(JSON_LENGTH(JSON_MERGE_PATCH(machine, ?), '$.machineMeta'), 0) <= ?
       AND COALESCE(JSON_LENGTH(JSON_MERGE_PATCH(machine, ?), '$.machines'), 0) <= ?`,
    [
      merge,
      slot.id,
      merge,
      PROGRAM_LIMITS.machineMetaKeys,
      merge,
      PROGRAM_LIMITS.machines,
    ],
  )
  if (result.affectedRows === 0) {
    // 0 also means "matched, but nothing changed". Only the cap is an error.
    const [[within]] = await pool.execute<RowDataPacket[]>(
      `SELECT COALESCE(JSON_LENGTH(JSON_MERGE_PATCH(machine, ?), '$.machineMeta'), 0) <= ?
          AND COALESCE(JSON_LENGTH(JSON_MERGE_PATCH(machine, ?), '$.machines'), 0) <= ?
          AS ok
       FROM program_exercises WHERE id = ?`,
      [merge, PROGRAM_LIMITS.machineMetaKeys, merge, PROGRAM_LIMITS.machines, slot.id],
    )
    if (within && !within.ok)
      throw new ValidationError(
        `An exercise may have at most ${PROGRAM_LIMITS.machines} machines and ${PROGRAM_LIMITS.machineMetaKeys} machineMeta entries`,
      )
  }
  return { exerciseIndex }
}

export async function patchExerciseSets(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  additionalSets: number,
): Promise<{ exerciseIndex: number; newSetCount: number }> {
  // Not parseInt: it read "5abc" as 5 and "1e9" as 1.
  const added = Number(additionalSets)
  if (!Number.isInteger(added))
    throw new ValidationError("additionalSets must be an integer")

  const slot = await requireSlot(userId, dayNumber, split, exerciseIndex)
  const newSetCount = slot.sets + added
  // ck_pe_sets stops a set count going negative. Say so in the caller's terms.
  if (newSetCount < 0)
    throw new ValidationError("An exercise cannot have fewer than 0 sets")

  try {
    await pool.execute(
      `UPDATE program_exercises SET target_sets = ? WHERE id = ?`,
      [newSetCount, slot.id],
    )
  } catch (err) {
    // target_sets is an INT: the negative side was already a 400, and an
    // overflow past its ceiling is the same class of bad request.
    throw throwCheckViolation(err, "That many sets is out of range")
  }
  return { exerciseIndex, newSetCount }
}
