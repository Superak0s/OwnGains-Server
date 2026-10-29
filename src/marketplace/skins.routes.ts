import { Router, type Response } from "express"
import rateLimit from "express-rate-limit"
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../middleware/errorHandler.js"
import { isUuid, parseIntParam, queryString } from "../middleware/validation.js"
import { authFailure, currentUser, optionalUser, requireTerms, requireUser } from "./auth.js"
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
    if (!authorUuid) throw authFailure(res) ?? new UnauthorizedError("Sign in to your OwnGains account first")
  }
  res.json(
    await skins.listSkins({ q: queryString(req, "q")?.trim(), sort, page, authorUuid, viewerUuid: currentUser(res)?.uuid }),
  )
})

skinsRouter.get("/:id", optionalUser, async (req, res) => {
  const user = currentUser(res)
  const found = await skins.findSkin(parseIntParam(req.params.id as string, "skin id"), user?.uuid)
  // A demo skin is visible only to its owner, so a failed sign-in check must not read as "no such skin".
  if (!found) throw authFailure(res) ?? new NotFoundError("Skin")
  const { authorUuid, ...detail } = found
  res.json({
    ...detail,
    myRating: user ? await skins.findRating(found.id, user.uuid) : null,
    url: skins.skinUrl(found.id),
    mine: !!user && user.uuid === authorUuid,
  })
})

skinsRouter.post("/", requireUser, requireTerms, publishLimiter, async (req, res) => {
  const upload = validateSkinUpload(req.body)
  const id = await skins.createSkin(upload, currentUser(res)!)
  res.status(201).json({ id, url: skins.skinUrl(id) })
})

/** The skin behind `:id` the signed-in caller can see, or 404. */
async function visibleOr404(id: string, res: Response) {
  const found = await skins.findSkin(parseIntParam(id, "skin id"), currentUser(res)!.uuid)
  if (!found) throw new NotFoundError("Skin")
  return found
}

skinsRouter.put("/:id", requireUser, requireTerms, async (req, res) => {
  const found = await visibleOr404(req.params.id as string, res)
  if (found.authorUuid !== currentUser(res)!.uuid) throw new ForbiddenError("Only the author can update this skin")
  const version = await skins.updateSkin(found.id, validateSkinUpload(req.body))
  res.json({ id: found.id, url: skins.skinUrl(found.id), version })
})

/** The 1 to 500 character `reason` a report or takedown must give. */
function reasonOf(body: unknown): string {
  const reason = (body as { reason?: unknown })?.reason
  const trimmed = typeof reason === "string" ? reason.trim() : ""
  if (!trimmed || trimmed.length > 500) throw new ValidationError("reason must be 1 to 500 characters")
  return trimmed
}

skinsRouter.delete("/:id", requireUser, async (req, res) => {
  const user = currentUser(res)!
  // First, so an author can also delete a skin that was taken down.
  if (await skins.deleteOwnSkin(parseIntParam(req.params.id as string, "skin id"), user.uuid))
    return void res.status(204).end()
  const found = await visibleOr404(req.params.id as string, res)
  if (!user.isAdmin) throw new ForbiddenError("Only the author can delete this skin")
  await skins.takeDownSkin(found.id, reasonOf(req.body))
  res.status(204).end()
})

skinsRouter.post("/:id/download", downloadLimiter, optionalUser, async (req, res) => {
  const installId = req.get("x-install-id")
  const counts = await skins.recordDownload(
    parseIntParam(req.params.id as string, "skin id"),
    isUuid(installId) ? installId : null,
    currentUser(res)?.uuid,
  )
  if (!counts) throw authFailure(res) ?? new NotFoundError("Skin")
  res.json(counts)
})

skinsRouter.put("/:id/rating", requireUser, requireTerms, async (req, res) => {
  const found = await visibleOr404(req.params.id as string, res)
  const stars = (req.body as { stars?: unknown })?.stars
  if (!Number.isInteger(stars) || (stars as number) < 1 || (stars as number) > 5)
    throw new ValidationError("stars must be a whole number from 1 to 5")
  res.json(await skins.rateSkin(found.id, currentUser(res)!.uuid, stars as number))
})

skinsRouter.post("/:id/report", requireUser, requireTerms, async (req, res) => {
  const found = await visibleOr404(req.params.id as string, res)
  await skins.addReport(found.id, currentUser(res)!.uuid, reasonOf(req.body))
  res.status(201).json({ success: true })
})
