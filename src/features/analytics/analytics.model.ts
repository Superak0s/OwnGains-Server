import type { RowDataPacket } from "mysql2"
import { pool } from "@/config/database.js"

interface AnalyticsSummary extends RowDataPacket {
  total_sessions: number
  total_sets: number
  total_volume: number
  first_session: Date | string | null
  last_session: Date | string | null
}

export async function getAnalytics(
  userId: number,
  split?: string | null,
  dayNumber?: number | null,
  days = 365,
): Promise<AnalyticsSummary> {
  let q = `
    SELECT
      COUNT(DISTINCT w.id) AS total_sessions,
      COUNT(ws.id) AS total_sets,
      COALESCE(SUM(ws.weight * ws.reps), 0) AS total_volume,
      MIN(w.start_time) AS first_session,
      MAX(w.start_time) AS last_session
    FROM workouts w
    LEFT JOIN workout_sets ws ON w.id = ws.workout_id
    WHERE w.user_id = ? AND w.end_time IS NOT NULL AND w.is_demo = 0
      AND w.start_time >= (NOW() - INTERVAL ? DAY)`
  const params: any[] = [userId, days]
  if (split) {
    q += ` AND w.split = ?`
    params.push(split)
  }
  // Use != null so dayNumber = 0 is still applied (falsy check would skip it)
  if (dayNumber != null) {
    q += ` AND w.day_number = ?`
    params.push(dayNumber)
  }
  const [rows] = await pool.execute<AnalyticsSummary[]>(q, params)
  return rows[0]
}
