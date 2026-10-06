// Body fat, a group of series in the shared `measurements` table. This file is
// only the US-Navy formula plus the mapping from metric rows to the shape the
// app expects. Weight is a plain series, so its routes call
// features/tracking/measurements/measurements.model.ts directly.

import type { BodyFatEntry } from "../tracking.types.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import {
  METRICS,
  logMetrics,
  getMetricGroups,
  deleteMetricGroup,
} from "../measurements/measurements.model.js"

// ─── Body fat percentage (US Navy formula) ────────────────────────────────────

export function calculateBodyFatPercentage(
  gender: "male" | "female",
  heightCm: number,
  waistCm: number,
  neckCm: number,
  hipCm?: number | null,
): number {
  // ValidationError, not Error: these are client-supplied measurements, so a
  // bad combination is a 400, not a 500 the cross-check route would leak.
  if (!heightCm || heightCm <= 0)
    throw new ValidationError("Invalid height measurement")
  if (!waistCm || waistCm <= 0)
    throw new ValidationError("Invalid waist measurement")
  if (!neckCm || neckCm <= 0)
    throw new ValidationError("Invalid neck measurement")

  let bf: number
  if (gender === "male") {
    const diff = waistCm - neckCm
    if (diff <= 0)
      throw new ValidationError("Waist must be greater than neck")
    bf =
      495 /
        (1.0324 - 0.19077 * Math.log10(diff) + 0.15456 * Math.log10(heightCm)) -
      450
  } else {
    if (!hipCm || hipCm <= 0)
      throw new ValidationError(
        "Hip measurement required for female calculation",
      )
    const sum = waistCm + hipCm - neckCm
    if (sum <= 0)
      throw new ValidationError("Waist + Hip must be greater than neck")
    bf =
      495 /
        (1.29579 - 0.35004 * Math.log10(sum) + 0.221 * Math.log10(heightCm)) -
      450
  }

  const result = Number.parseFloat(bf.toFixed(1))
  if (Number.isNaN(result) || result < 0 || result > 100)
    throw new ValidationError(
      `Invalid body fat result: ${result}%. Check your measurements.`,
    )
  return result
}

// One body-fat log writes the percentage AND the circumferences it was derived
// from, all under one measured_at. They used to be columns of one row. As
// metric rows they are also plain waist/neck/hip series the charts can use.
const BODY_FAT_PIVOT = {
  percentage: METRICS.bodyFatPct,
  waist: METRICS.waistCm,
  neck: METRICS.neckCm,
  hip: METRICS.hipCm,
} as const

const BODY_FAT_METRICS = Object.values(BODY_FAT_PIVOT)

export async function logBodyFat(
  userId: number,
  percentage: number,
  waistCm: number | null,
  neckCm: number | null,
  hipCm: number | null,
  measuredAt: string | Date,
): Promise<BodyFatEntry> {
  const id = await logMetrics(
    userId,
    [
      { metric: METRICS.bodyFatPct, value: percentage },
      ...(waistCm ? [{ metric: METRICS.waistCm, value: waistCm }] : []),
      ...(neckCm ? [{ metric: METRICS.neckCm, value: neckCm }] : []),
      ...(hipCm ? [{ metric: METRICS.hipCm, value: hipCm }] : []),
    ],
    measuredAt,
  )
  return {
    id,
    percentage,
    measurements: { waist: waistCm, neck: neckCm, hip: hipCm, unit: "cm" },
    date: measuredAt,
  }
}

export async function getBodyFatHistory(
  userId: number,
  limit = 90,
): Promise<BodyFatEntry[]> {
  const rows = await getMetricGroups(
    userId,
    BODY_FAT_PIVOT,
    limit,
    METRICS.bodyFatPct,
  )
  return rows.map((r) => ({
    id: r.id,
    // METRICS.bodyFatPct is the required metric, so every group has one.
    percentage: r.values.percentage!,
    measurements: {
      waist: r.values.waist,
      neck: r.values.neck,
      hip: r.values.hip,
      unit: "cm",
    },
    date: r.measuredAt,
  }))
}

export async function deleteBodyFatEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  // Removes the whole measuring session, which is what one of these entries was
  // before the merge.
  return deleteMetricGroup(userId, entryId, BODY_FAT_METRICS)
}
