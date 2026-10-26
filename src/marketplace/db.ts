import fs from "node:fs"
import path from "node:path"
import { createDatabaseIfNotExists, parseSQLStatements, pool } from "../config/database.js"

/** Creates the marketplace database if missing and runs its schema. Safe on every boot. */
export async function ensureMarketplaceSchema(): Promise<void> {
  await createDatabaseIfNotExists()
  const sql = fs.readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8")
  for (const statement of parseSQLStatements(sql)) await pool.query(statement)
}
