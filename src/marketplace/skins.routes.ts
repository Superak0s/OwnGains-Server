import { Router } from "express"
import rateLimit from "express-rate-limit"
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../middleware/errorHandler.js"
import { isUuid, parseIntParam, queryString } from "../middleware/validation.js"
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

const downloadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !!process.env.VITEST,
  message: { success: false, error: "Too many downloads, please try again later" },
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
  if (!found) throw new NotFoundError("Skin")
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
async function visibleOr404(id: string) {
  const found = await skins.findSkin(parseIntParam(id, "skin id"))
  if (!found) throw new NotFoundError("Skin")
  return found
}

skinsRouter.put("/:id", requireUser, async (req, res) => {
  const found = await visibleOr404(req.params.id as string)
  if (found.authorUuid !== currentUser(res)!.uuid) throw new ForbiddenError("Only the author can update this skin")
  const version = await skins.updateSkin(found.id, validateSkinUpload(req.body))
  res.json({ id: found.id, url: skins.skinUrl(found.id), version })
})

skinsRouter.delete("/:id", requireUser, async (req, res) => {
  const found = await visibleOr404(req.params.id as string)
  const user = currentUser(res)!
  if (found.authorUuid === user.uuid) await skins.deleteSkin(found.id)
  else if (user.isAdmin) await skins.takeDownSkin(found.id)
  else throw new ForbiddenError("Only the author can delete this skin")
  res.status(204).end()
})

skinsRouter.post("/:id/download", downloadLimiter, async (req, res) => {
  const installId = req.get("x-install-id")
  const counts = await skins.recordDownload(parseIntParam(req.params.id as string, "skin id"), isUuid(installId) ? installId : null)
  if (!counts) throw new NotFoundError("Skin")
  res.json(counts)
})

skinsRouter.put("/:id/rating", requireUser, async (req, res) => {
  const found = await visibleOr404(req.params.id as string)
  const stars = (req.body as { stars?: unknown })?.stars
  if (!Number.isInteger(stars) || (stars as number) < 1 || (stars as number) > 5)
    throw new ValidationError("stars must be a whole number from 1 to 5")
  res.json(await skins.rateSkin(found.id, currentUser(res)!.uuid, stars as number))
})

skinsRouter.post("/:id/report", requireUser, async (req, res) => {
  const found = await visibleOr404(req.params.id as string)
  const reason = (req.body as { reason?: unknown })?.reason
  const trimmed = typeof reason === "string" ? reason.trim() : ""
  if (!trimmed || trimmed.length > 500) throw new ValidationError("reason must be 1 to 500 characters")
  await skins.addReport(found.id, currentUser(res)!.uuid, trimmed)
  res.status(201).json({ success: true })
})
