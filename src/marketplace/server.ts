import http from "node:http"
import { pathToFileURL } from "node:url"
import { pool } from "../config/database.js"
import { logger } from "../utils/logger.js"
import { app } from "./app.js"
import { ensureMarketplaceSchema } from "./db.js"
import { marketplaceConfig } from "./env.js"

if (marketplaceConfig.downloadSalt.length < 32)
  throw new Error("DOWNLOAD_SALT must be set to at least 32 characters of randomness")

const server = http.createServer(app)
let shuttingDown = false

function shutdown(exitCode: number): void {
  if (shuttingDown) return
  shuttingDown = true
  setTimeout(() => process.exit(exitCode), 5000).unref()
  server.close(async () => {
    try {
      await pool.end()
    } catch (err) {
      logger.error("Error closing DB pool:", err)
    }
    process.exit(exitCode)
  })
}

async function start(): Promise<void> {
  await ensureMarketplaceSchema()
  server.listen(marketplaceConfig.port, () => {
    logger.info(
      `OwnGains marketplace on port ${marketplaceConfig.port}, trusting ${marketplaceConfig.authServerUrl}, public at ${marketplaceConfig.publicUrl}`,
    )
  })
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  start().catch((err) => {
    logger.error("Failed to start marketplace:", (err as Error).message)
    process.exit(1)
  })
  process.on("SIGTERM", () => shutdown(0))
  process.on("SIGINT", () => shutdown(0))
}
