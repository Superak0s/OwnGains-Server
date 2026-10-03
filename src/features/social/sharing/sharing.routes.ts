// /api/sharing: three routers over one prefix, split by what they serve.
// The paths are unchanged. Each sub-router spells its own out in full.
import { Router } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "@/features/tracking/healthConsent.js"
import permissionsRoutes from "./sharing.permissions.routes.js"
import jointRoutes from "./sharing.joint.routes.js"
import watchRoutes from "./sharing.watch.routes.js"

const router: Router = Router()

router.use(authenticateToken, healthConsentGuard)
router.use(permissionsRoutes)
router.use(jointRoutes)
router.use(watchRoutes)

export default router
