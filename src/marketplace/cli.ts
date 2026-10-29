#!/usr/bin/env bun
import type { RowDataPacket } from "mysql2/promise"
import { pathToFileURL } from "node:url"
import { pool } from "../config/database.js"
import { isUuid, parseIntParam } from "../middleware/validation.js"
import { anonymizeUsers, takeDownSkin } from "./skins.model.js"

const USAGE = `Usage:
  marketplace reports [limit]   newest reports first
  marketplace remove <skin id> <reason>  take a skin down (kept, hidden), the reason shown to its author
  marketplace forget <uuid>     anonymize an account's skins, ratings and reports`

/** Runs one command and returns the exit code. */
export async function main(args: string[]): Promise<number> {
  const [cmd, arg, ...rest] = args
  try {
    if (cmd === "reports") {
      const limit = arg ? parseIntParam(arg, "limit") : 50
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT r.skin_id, s.name, r.reason, r.created_at FROM skin_reports r JOIN skins s ON s.id = r.skin_id
          WHERE s.taken_down_at IS NULL ORDER BY r.id DESC LIMIT ${limit}`,
      )
      for (const r of rows) console.log(`#${r.skin_id} ${r.name} (${r.created_at}): ${r.reason}`)
      if (!rows.length) console.log("No open reports")
      return 0
    }
    const reason = rest.join(" ").trim()
    if (cmd === "remove" && arg && reason) {
      await takeDownSkin(parseIntParam(arg, "skin id"), reason.slice(0, 500))
      console.log(`Skin ${arg} taken down`)
      return 0
    }
    if (cmd === "forget" && isUuid(arg)) {
      await anonymizeUsers([arg])
      console.log(`Account ${arg} anonymized`)
      return 0
    }
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
  console.error(USAGE)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2))
  await pool.end()
  process.exit(code)
}
