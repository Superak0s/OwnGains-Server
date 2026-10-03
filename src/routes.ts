import { Application, Request, Response, Router } from "express"

import { version } from "@/config/version.js"
import { authenticateToken } from "./middleware/auth.js"
import { envBool, readLocalOnlyFeatures } from "./config/env.js"
import authRoutes from "./features/auth/auth.routes.js"
import adminRoutes from "./features/auth/admin.routes.js"
import settingsRoutes from "./features/settings/settings.routes.js"
import analyticsRoutes from "./features/analytics/analytics.routes.js"
import sessionRoutes from "./features/workouts/workouts.routes.js"
import programRoutes from "./features/programs/programs.routes.js"
import friendRoutes from "./features/social/friends/friends.routes.js"
import sharingRoutes from "./features/social/sharing/sharing.routes.js"
import macrosRoutes from "./features/tracking/macros/macros.routes.js"
import bodyStatsRoutes from "./features/tracking/bodyStats/bodyStats.routes.js"
import measurementsRoutes from "./features/tracking/measurements/measurements.routes.js"
import hydrationRoutes from "./features/tracking/hydration/hydration.routes.js"
import sorenessRoutes from "./features/tracking/soreness/soreness.routes.js"
import menstrualRoutes from "./features/tracking/menstrual/menstrual.routes.js"
import supplementRoutes from "./features/tracking/supplements/supplements.routes.js"
import injuryRoutes from "./features/tracking/injury/injury.routes.js"
import personalNotesRoutes from "./features/tracking/personalNotes/personalNotes.routes.js"
import progressPhotoRoutes from "./features/tracking/progressPhoto/progressPhoto.routes.js"
import metricsRoutes from "./features/metrics/metrics.routes.js"
import metricsPage from "./features/metrics/metrics.page.js"
import legalRoutes from "./features/legal/legal.routes.js"
import { metricsEnabled, metricsPageEnabled } from "./features/metrics/metrics.collector.js"

// Features this deployment refuses to store. The client reads the same list
// from /healthz and logs them on-device instead.
export const localOnlyFeatures = readLocalOnlyFeatures()

const serves = (feature: string): boolean => !localOnlyFeatures.includes(feature)

// A local-only feature's routes answer 410 instead of 404, so a client with a
// stale feature list (or an offline-queued write) learns to keep it on-device
// rather than treating the refusal as a missing route or a bug.
const refuseLocalOnly = (feature: string) => (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    code: "FEATURE_LOCAL_ONLY",
    feature,
    error: `This server keeps ${feature} on each device only`,
  })
}

const trackingRoutes: [string, Router][] = [
  ["/api/tracking/bodystats", bodyStatsRoutes],
  ["/api/tracking/measurements", measurementsRoutes],
  ["/api/tracking/hydration", hydrationRoutes],
  ["/api/tracking/soreness", sorenessRoutes],
  ["/api/tracking/menstrual", menstrualRoutes],
  ["/api/tracking/macros", macrosRoutes],
  ["/api/tracking/injuries", injuryRoutes],
  ["/api/tracking/personal-notes", personalNotesRoutes],
  ["/api/tracking/photos/muscle", progressPhotoRoutes],
  // Every column is a tracking goal, menstrual cycle length included.
  ["/api/settings", settingsRoutes],
]

export function registerRoutes(app: Application): void {
  // Auth-gated: the exact server version could be used to target known CVEs.
  app.get("/api/version", authenticateToken, (_req: Request, res: Response) => {
    res.json({ success: true, version })
  })
  app.use("/api/auth", authRoutes)
  // METRICS_ENABLED=false unmounts both, so they 404 like any unknown path.
  // The page is outside /api: it is static HTML that contains no data, and signs
  // in through /api/auth/signin like the app does.
  if (metricsEnabled) app.use("/api/admin/metrics", metricsRoutes)
  if (metricsPageEnabled) app.use("/admin/metrics", metricsPage)
  // Off by default: the pages name the official server's data controller.
  if (envBool("LEGAL_PAGES_ENABLED", false)) app.use(legalRoutes)
  app.use("/api/admin", adminRoutes)
  app.use("/api/analytics", analyticsRoutes)
  app.use("/api/sessions", sessionRoutes)
  app.use("/api/program", programRoutes)
  app.use("/api/friends", friendRoutes)
  app.use("/api/sharing", sharingRoutes)
  if (serves("tracking")) {
    for (const [path, router] of trackingRoutes) app.use(path, router)
  } else {
    app.use(trackingRoutes.map(([path]) => path), refuseLocalOnly("tracking"))
  }
  if (serves("supplements")) {
    app.use("/api/tracking/supplements", supplementRoutes)
  } else {
    app.use("/api/tracking/supplements", refuseLocalOnly("supplements"))
  }
}
