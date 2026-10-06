import mysql from "mysql2/promise"
import path from "node:path"
import fs from "node:fs"
import { parseEnv } from "node:util"

// Runs once in the main vitest process before any worker starts.
// Wipes and rebuilds the scratch DB from schema.sql + migrations.
export default async function setup() {
  const envPath = path.join(process.cwd(), ".env")
  if (!fs.existsSync(envPath))
    throw new Error("tests require a .env file at the repo root")
  const envDbName = parseEnv(fs.readFileSync(envPath, "utf8")).DB_NAME
  // Same default as setup-env.ts: the .env DB_NAME plus "_test".
  const dbName = process.env.TEST_DB_NAME || `${envDbName || "owngains"}_test`
  if (!/^\w+$/.test(dbName)) throw new Error("TEST_DB_NAME must be a plain identifier")
  // The suite drops this database. If the dev server uses it too, every run
  // wipes the developer's real accounts.
  if (envDbName === dbName)
    throw new Error(
      `.env DB_NAME is "${dbName}", the database the tests drop. Point DB_NAME at another database or set TEST_DB_NAME.`,
    )
  process.env.DB_NAME = dbName
  process.loadEnvFile(envPath)

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT) || 3306,
  })
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
  } finally {
    await conn.end()
  }

  // testDatabaseConnection() recreates the DB, all tables, and applies migrations.
  const { testDatabaseConnection, pool } = await import("@/config/database.js")
  await testDatabaseConnection()

  // Vitest uses globalSetup's return value as the teardown hook. This pool is created in
  // the main vitest process, where server.ts's shutdown() never runs to close it. Without
  // this its open sockets keep the process alive and vitest reports "close timed out".
  return () => pool.end()
}
