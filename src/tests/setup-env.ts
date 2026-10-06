import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"

// Runs before every test file's imports in each worker.
// Set overrides first so loadEnvFile (which never clobbers existing vars)
// only fills in DB creds from the real .env.
// The test DB defaults to the .env DB_NAME plus "_test". Read from the file, not
// process.env, which this file already overwrote if it ran earlier in this worker.
// TEST_DB_NAME lets parallel checkouts on one MySQL run the suite without clobbering each other.
const envPath = fileURLToPath(new URL("../../.env", import.meta.url))
const envDbName = parseEnv(fs.readFileSync(envPath, "utf8")).DB_NAME
process.env.DB_NAME = process.env.TEST_DB_NAME || `${envDbName || "owngains"}_test`
process.env.JWT_SECRET = "test-jwt-secret-0123456789-0123456789"
process.env.ALLOWED_ORIGINS = "http://localhost:3000"
process.env.NODE_ENV = "development"
delete process.env.PORT
// The rate-limit tests count to the defaults. A dev .env that raises them or
// bypasses loopback (supertest's address) would make them never trip.
process.env.RATE_LIMIT_BYPASS_LOCAL_IPS = "false"
process.env.TRUST_PROXY_HOPS = "0"
process.env.AUTH_RATE_LIMIT = "20"
process.env.SIGNUP_RATE_LIMIT = "20"
process.env.API_RATE_LIMIT = "200"
process.env.LARGE_BODY_RATE_LIMIT = "20"

process.loadEnvFile(envPath)

