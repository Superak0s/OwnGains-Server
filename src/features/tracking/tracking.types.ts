// Types shared across more than one tracking sub-feature. A type used by a
// feature on its own is defined in that feature's own model file instead.

export interface BodyFatEntry {
  id: number
  percentage: number
  // The circumferences the percentage was derived from. They are also plain
  // metric series of their own now. This block is kept because the app reads a
  // body-fat entry as one object.
  measurements: {
    waist: number
    neck: number
    hip: number | null
    unit: string
  }
  date: Date | string
}

export interface MacrosEntry {
  id: number
  name: string | null
  protein: number | null
  carbs: number | null
  fat: number | null
  calories: number | null
  errorMargin: number
  // No separate `time` field: `takenAt` is the one timestamp, formatted by the
  // client in the viewer's locale rather than by the server in UTC.
  takenAt: Date | string
  note: string | null
}

