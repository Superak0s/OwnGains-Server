/** Per-machine note and pin/seat setting, keyed by machine name. */
interface MachineMeta {
  note?: string
  setting?: string
}

/**
 * The exercise fields `PATCH /exercise/machine` is allowed to touch. Kept as
 * its own type so the route's whitelist and this interface can't drift.
 */
export interface MachineFields {
  /** Machines/setups this exercise can be run on. */
  machines?: string[]
  /** The machine in use, stamped onto each set as `machineName`. */
  selectedMachine?: string
  /** Machine selected when the exercise is opened with no explicit choice. */
  defaultMachine?: string
  /** Best stats pool every machine instead of just the selected one. */
  bestAcrossMachines?: boolean
  machineMeta?: Record<string, MachineMeta>
}

export interface Exercise extends MachineFields {
  name: string
  primaryMuscles?: string[]
  secondaryMuscles?: string[]
  sets: number
  /** Free-text per-exercise rep target ("10", "8-12"), absent when not prescribed. */
  reps?: string
  /** Canonical id from the bundled exercise DB, or null for a custom exercise. */
  exerciseId?: string | null
}

/** Exercise row that also tracks per-split set counts (used in day views). */
interface ExerciseWithSets {
  name: string
  primaryMuscles: string[]
  secondaryMuscles: string[]
  reps?: string
  exerciseId?: string | null
  setsBySplit: Record<string, number>
}

interface SplitWorkout {
  exercises: Exercise[]
  totalSets: number
}

export interface ProgramDay {
  dayNumber: number
  dayTitle: string
  primaryMuscles?: string[]
  secondaryMuscles?: string[]
  /** Flat exercise list with per-split set counts, used by parser output. */
  exercises: ExerciseWithSets[]
  /** Per-split exercise lists, used at runtime. */
  split: Record<string, SplitWorkout>
}

export interface ProgramData {
  days: ProgramDay[]
  split: string[]
}

export interface StoredProgram {
  programData: ProgramData
  originalFilename: string
  // dateStrings on the pool: DATETIME columns arrive as strings, not Dates.
  uploadedAt: string
  /** The day pointer GET/PUT /current-day manage, null until one is set. */
  currentDay: number | null
}
