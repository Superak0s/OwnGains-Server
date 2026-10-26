import { Router } from "express"
import rateLimit from "express-rate-limit"
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../middleware/errorHandler.js"
import { parseIntParam, queryString } from "../middleware/validation.js"
import { currentUser, optionalUser, requireUser } from "./auth.js"
import { validateSkinUpload } from "./skinFormat.js"
import * as skins from "./skins.model.js"

export const skinsRouter = Router()

const publishLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => `user:${currentUser(res)!.uuid}`,
  skip: () => !!process.env.VITEST,
  message: { success: false, error: "You can publish 10 skins an hour. Try again later." },
})

const SORTS = new Set<skins.SkinSort>(["popular", "rating", "new"])

skinsRouter.get("/", optionalUser, async (req, res) => {
  const sort = (queryString(req, "sort") ?? "popular") as skins.SkinSort
  if (!SORTS.has(sort)) throw new ValidationError("sort must be popular, rating or new")
  const pageParam = queryString(req, "page")
  const page = pageParam === undefined ? 1 : parseIntParam(pageParam, "page")
  let authorUuid: string | undefined
  if (queryString(req, "mine") === "1") {
    authorUuid = currentUser(res)?.uuid
    if (!authorUuid) throw new UnauthorizedError("Sign in to your OwnGains account first")
  }
  res.json(await skins.listSkins({ q: queryString(req, "q")?.trim(), sort, page, authorUuid }))
})

skinsRouter.get("/:id", optionalUser, async (req, res) => {
  const found = await skins.findSkin(parseIntParam(req.params.id as string, "skin id"))
  if (!found) throw new NotFoundError("Skin not found")
  const user = currentUser(res)
  const { authorUuid, ...detail } = found
  res.json({
    ...detail,
    myRating: user ? await skins.findRating(found.id, user.uuid) : null,
    url: skins.skinUrl(found.id),
    mine: !!user && user.uuid === authorUuid,
  })
})

skinsRouter.post("/", requireUser, publishLimiter, async (req, res) => {
  const upload = validateSkinUpload(req.body)
  const id = await skins.createSkin(upload, currentUser(res)!)
  res.status(201).json({ id, url: skins.skinUrl(id) })
})

/** The visible skin behind `:id`, or 404. */
async function ownedOr404(id: string) {
  const found = await skins.findSkin(parseIntParam(id, "skin id"))
  if (!found) throw new NotFoundError("Skin not found")
  return found
}

skinsRouter.put("/:id", requireUser, async (req, res) => {
  const found = await ownedOr404(req.params.id as string)
  if (found.authorUuid !== currentUser(res)!.uuid) throw new ForbiddenError("Only the author can update this skin")
  const version = await skins.updateSkin(found.id, validateSkinUpload(req.body))
  res.json({ id: found.id, url: skins.skinUrl(found.id), version })
})

skinsRouter.delete("/:id", requireUser, async (req, res) => {
  const found = await ownedOr404(req.params.id as string)
  const user = currentUser(res)!
  if (found.authorUuid === user.uuid) await skins.deleteSkin(found.id)
  else if (user.isAdmin) await skins.takeDownSkin(found.id)
  else throw new ForbiddenError("Only the author can delete this skin")
  res.status(204).end()
})
