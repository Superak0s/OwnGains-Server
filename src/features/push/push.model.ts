import { pool } from "@/config/database.js"
import type { RowDataPacket } from "mysql2"

/** Stores a device's token for the user, taking it over from whoever had it before. */
export async function saveToken(userId: number, token: string): Promise<void> {
  await pool.execute(
    "INSERT INTO push_tokens (token, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), updated_at = NOW()",
    [token, userId],
  )
}

export async function tokensFor(userId: number): Promise<string[]> {
  const [rows] = await pool.execute<(RowDataPacket & { token: string })[]>(
    "SELECT token FROM push_tokens WHERE user_id = ?",
    [userId],
  )
  return rows.map((r) => r.token)
}

export async function forgetToken(token: string): Promise<void> {
  await pool.execute("DELETE FROM push_tokens WHERE token = ?", [token])
}
