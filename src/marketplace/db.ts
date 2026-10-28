import fs from "node:fs"
import path from "node:path"
import { createDatabaseIfNotExists, parseSQLStatements, pool } from "../config/database.js"

/** Creates the marketplace database if missing and runs its schema. Safe on every boot. */
export async function ensureMarketplaceSchema(): Promise<void> {
  // Its own DB user is granted only the skin* tables, so it can't run CREATE DATABASE.
  // The database is the server's, which already exists.
  await createDatabaseIfNotExists().catch((err: { code?: string }) => {
    if (err.code !== "ER_DBACCESS_DENIED_ERROR") throw err
  })
  const sql = fs.readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8")
  for (const statement of parseSQLStatements(sql)) await pool.query(statement)
}
