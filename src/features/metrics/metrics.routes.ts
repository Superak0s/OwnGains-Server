import { Router, Request, Response } from "express"
import { version } from "@/config/version.js"
import { authenticateToken, requireAdmin } from "@/middleware/auth.js"
import { envBool, envInt, readLocalOnlyFeatures } from "@/config/env.js"
import { getWsStats } from "@/ws/wsServer.js"
import { decodesInUse, MAX_CONCURRENT_DECODES } from "@/middleware/imageUpload.js"
import { clearErrors, metricsPageEnabled, processSnapshot } from "./metrics.collector.js"
import { getDbSnapshot, poolStats } from "./metrics.model.js"

/**
 * GET /api/admin/metrics: everything the /admin/metrics page draws, as JSON,
 * for the app's own admin screen too. Admin-only, like the rest of /api/admin.
 * Not mounted at all when METRICS_ENABLED=false.
 */
const router: Router = Router()

router.use(authenticateToken, requireAdmin)

// Operator-facing settings to show at a glance, read once at boot like the
// server itself does. Only switches and counts: nothing secret (no DB
// credentials, no JWT secret, no origins list).
const config = {
  nodeEnv: process.env.NODE_ENV ?? null,
  localOnlyFeatures: readLocalOnlyFeatures(),
  trustProxyHops: envInt("TRUST_PROXY_HOPS", 0),
  mdnsEnabled: envBool("MDNS_ENABLED", true),
  serverFqdn: process.env.SERVER_FQDN || null,
  bootstrapAdminSet: !!process.env.BOOTSTRAP_ADMIN_USERNAME,
  metricsPageEnabled,
}

router.get("/", async (_req: Request, res: Response) => {
  const db = await getDbSnapshot()
  res.set("Cache-Control", "no-store")
  res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    version,
    ...processSnapshot(),
    websocket: getWsStats(),
    uploads: {
      decodesInUse: decodesInUse(),
      maxConcurrentDecodes: MAX_CONCURRENT_DECODES,
    },
    database: { pool: poolStats(), ...db },
    config,
  })
})

/**
 * Forget the recorded errors, slow requests and error-log lines, for "I fixed
 * it, show me only what happens from now on". Request totals, routes and
 * history are kept.
 */
router.delete("/errors", (_req: Request, res: Response) => {
  clearErrors()
  res.json({ success: true, message: "Error log cleared" })
})

export default router
