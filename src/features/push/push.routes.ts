import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import { forgetToken, saveToken } from "./push.model.js"
import { pushEnabled } from "./fcm.js"

const router: Router = Router()

function requireToken(body: unknown): string {
  const { token } = (body ?? {}) as { token?: unknown }
  if (typeof token !== "string" || !token || token.length > 255)
    throw new ValidationError("token must be a string of at most 255 characters")
  return token
}

// Holding the token is proof enough to stop pushes to that device, and a signed-out
// app whose session was revoked has nothing else to authenticate with.
router.delete("/token", async (req: Request, res: Response) => {
  await forgetToken(requireToken(req.body))
  res.json({ success: true })
})

router.put("/token", authenticateToken, async (req: Request, res: Response) => {
  await saveToken(req.user!.id, requireToken(req.body))
  res.json({ success: true, enabled: pushEnabled() })
})

export default router
