import { describe, it, expect } from "vitest"
import type { RowDataPacket } from "mysql2"
import { pool } from "../../../config/database.js"
import { signup, internalId, uniqueName } from "../../../tests/helpers.js"
import { createUser } from "../auth.model.js"
import { purgeUnconsentedAccounts } from "../user.model.js"

async function ageUnconsented(id: number) {
  // is_admin = 0: the first sign-up on a fresh test database is the admin.
  await pool.execute(
    `UPDATE users SET terms_accepted_at = NULL, is_admin = 0,
       created_at = NOW() - INTERVAL 40 DAY WHERE id = ?`,
    [id],
  )
}

async function exists(id: number) {
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE id = ?", [id])
  return rows.length === 1
}

// An account from before the consent screen (or on a box with
// REQUIRE_TERMS_ACCEPTANCE=false) that only ever used tracking is not an
// abandoned sign-up. The purge used to look at programs and workouts only.
describe("purgeUnconsentedAccounts", () => {
  it("keeps an old account that holds tracking data", async () => {
    const u = await signup("dpurge")
    const id = await internalId(u.user.id)
    await ageUnconsented(id)
    // Sign-up recorded consent rows. Drop them so the measurement is what
    // keeps the account.
    await pool.execute("DELETE FROM consent_events WHERE user_id = ?", [id])
    await pool.execute(
      `INSERT INTO measurements (user_id, metric, value, measured_at)
       VALUES (?, 'weight_kg', 80, NOW() - INTERVAL 39 DAY)`,
      [id],
    )

    await purgeUnconsentedAccounts()
    expect(await exists(id)).toBe(true)
  })

  it("still deletes an abandoned sign-up with nothing stored", async () => {
    const name = uniqueName("dempty")
    const id = await createUser(name, `${name}@test.local`, "Passw0rd-123")
    await ageUnconsented(id)

    await purgeUnconsentedAccounts()
    expect(await exists(id)).toBe(false)
  })
})
