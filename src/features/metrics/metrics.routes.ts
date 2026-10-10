import { Router, Request, Response } from "express"
import { version } from "@/config/version.js"
import { authenticateToken, requireAdmin } from "@/middleware/auth.js"
import { envBool, envInt, readLocalOnlyFeatures } from "@/config/env.js"
import { getWsStats } from "@/ws/wsServer.js"
import { decodesInUse, MAX_CONCURRENT_DECODES } from "@/middleware/imageUpload.js"
import { queryString } from "@/middleware/validation.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import { botAlertsEnabled, healthLimits } from "./metrics.alerts.js"
import { clearErrors, metricsPageEnabled, processSnapshot, WINDOWS, type Window } from "./metrics.collector.js"
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
  botAlertsEnabled,
  healthAlerts: healthLimits,
}

// ?window=15m|1h|6h|24h|7d|30d|all, or custom with ?from=&to= (any date
// Date.parse reads), picks what traffic, latency, errors and slow requests
// cover (default 1h). Routes and the database figures don't change.
function parseWindow(req: Request): Window {
  const key = queryString(req, "window") ?? "1h"
  if (key === "custom") {
    const fromMs = Date.parse(queryString(req, "from") ?? "")
    const toMs = Date.parse(queryString(req, "to") ?? "")
    if (!(fromMs < toMs)) throw new ValidationError("window=custom needs from and to dates, from before to")
    return { fromMs, toMs }
  }
  if (!Object.hasOwn(WINDOWS, key))
    throw new ValidationError(`window must be one of ${Object.keys(WINDOWS).join(", ")}, custom`)
  return key as Window
}

router.get("/", async (req: Request, res: Response) => {
  const window = parseWindow(req)
  const [db, snapshot] = await Promise.all([getDbSnapshot(), processSnapshot(window)])
  res.set("Cache-Control", "no-store")
  res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    version,
    ...snapshot,
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
 * Forget the recorded error events, slow requests and error-log lines, for "I
 * fixed it, show me only what happens from now on". Counts, routes and charts
 * are kept.
 */
router.delete("/errors", async (_req: Request, res: Response) => {
  await clearErrors()
  res.json({ success: true, message: "Error log cleared" })
})

export default router
