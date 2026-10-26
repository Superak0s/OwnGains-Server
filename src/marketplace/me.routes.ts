import { Router } from "express"
import { currentUser, requireUser } from "./auth.js"
import { anonymizeUser } from "./skins.model.js"

export const meRouter = Router()

meRouter.delete("/", requireUser, async (_req, res) => {
  await anonymizeUser(currentUser(res)!.uuid)
  res.status(204).end()
})
