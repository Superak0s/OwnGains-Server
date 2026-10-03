import { Router, Request, Response } from "express"
import rateLimit from "express-rate-limit"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import {
  photoUpload,
  assertImageUpload,
  uploadSlot,
  tryAcquireDecodeSlot,
  UploadBusyError,
} from "@/middleware/imageUpload.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import {
  queryLimit,
  queryString,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import { formatDateForMySQL, parseMySQLDate } from "@/config/database.js"
import {
  uploadPhoto,
  getAllPhotos,
  getPhotosByMuscle,
  getPhotoHash,
  getPhotoImage,
  getPhotoThumb,
  buildMissingThumb,
  deletePhoto,
} from "./progressPhoto.model.js"

const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

// Per account rather than per IP: the global /api limiter can't tell a photo
// upload (10 MB of body and a bounded but real decode) from a GET. Sixty in
// fifteen minutes is a whole gym-mirror session with retries to spare.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `photo-upload:${req.user!.id}`,
  skip: () => !!process.env.VITEST,
  message: { success: false, error: "Too many photo uploads, please try again later" },
})

// Order matters: the rate limit and the decode slot are both claimed before
// multer buffers the body, so a refused upload costs nothing.
router.post(
  "/",
  uploadLimiter,
  uploadSlot,
  photoUpload.single("photo"),
  async (req: Request, res: Response) => {
    assertImageUpload(req.file)

    const { takenAt, note, angle, customSideName } = req.body
    let muscleGroups: string[] = []
    if (req.body.muscleGroups) {
      try {
        muscleGroups = JSON.parse(req.body.muscleGroups)
      } catch {
        throw new ValidationError("muscleGroups must be a JSON array")
      }
    }
    if (!Array.isArray(muscleGroups) || muscleGroups.length === 0) {
      throw new ValidationError("At least one muscle group is required")
    }

    const id = await uploadPhoto(
      req.user!.id,
      req.file.buffer,
      req.file.mimetype,
      muscleGroups,
      note || null,
      angle || "custom",
      customSideName || null,
      parseBackdatedTimestamp(takenAt || null, "takenAt"),
    )

    const uri = `/api/tracking/photos/muscle/${id}/image`
    const thumbUri = `/api/tracking/photos/muscle/${id}/thumb`
    res.status(201).json({ success: true, data: { id, uri, thumbUri }, id })
  },
)

router.get("/", async (req: Request, res: Response) => {
  const rawLimit = queryString(req, "limit")
  if (rawLimit !== undefined && !/^\d+$/.test(rawLimit))
    throw new ValidationError("limit must be a number")
  const limit = queryLimit(req, { def: 100, max: 500 })
  const before = queryString(req, "before")
  const beforeId = queryString(req, "beforeId")
  // Accepts ISO or the "YYYY-MM-DD HH:MM:SS" takenAt that nextCursor echoes.
  // formatDateForMySQL throws a ValidationError on anything unparseable.
  const cursor = before
    ? {
        before: formatDateForMySQL(parseMySQLDate(before)),
        beforeId: beforeId ? parseIntParam(beforeId, "beforeId") : 0,
      }
    : undefined
  const { data, nextCursor } = await getAllPhotos(req.user!.id, limit, cursor)
  res.json({ success: true, data, nextCursor })
})

router.get("/group/:muscle", async (req: Request, res: Response) => {
  const photos = await getPhotosByMuscle(
    req.user!.id,
    String(req.params.muscle),
    queryLimit(req, { def: 100, max: 500 }),
  )
  res.json({ success: true, data: photos })
})

/** True when an If-None-Match header lists `etag` (or `*`). */
function matchesIfNoneMatch(req: Request, etag: string): boolean {
  const header = req.get("If-None-Match")
  if (!header) return false
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag || t === "*")
}

// api-audit: external -- reached via the `uri` that formatMeta puts on every
// photo record, which the app resolves to an absolute URL and hands to <Image>.
router.get("/:id/image", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const photoId = parseIntParam(String(req.params.id), "photo ID")

  // A revalidation is answered from the metadata row: the stored hash is the
  // ETag, so a 304 never reads the LONGBLOB into the heap.
  if (req.get("If-None-Match")) {
    const hash = await getPhotoHash(userId, photoId)
    if (hash && matchesIfNoneMatch(req, `"${hash}"`)) {
      res.set("ETag", `"${hash}"`)
      res.set("Cache-Control", `private, max-age=${86_400}`)
      res.status(304).end()
      return
    }
  }

  const result = await getPhotoImage(userId, photoId)
  res.set("Content-Type", result.mimeType)
  // mime_type is constrained to an image allowlist at write time and helmet
  // sends nosniff globally, so this is belt-and-braces: it pins how a browser
  // treats the response rather than leaving it to content sniffing.
  res.set("Content-Disposition", "inline")
  res.set("Cache-Control", `private, max-age=${86_400}`)
  // Set before send(), so Express uses it instead of hashing the blob again.
  res.set("ETag", `"${result.hash}"`)
  res.send(result.photoData)
})

// Same ownership check and caching as /:id/image, always a JPEG.
router.get("/:id/thumb", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const photoId = parseIntParam(String(req.params.id), "photo ID")
  let thumb = await getPhotoThumb(userId, photoId)
  if (!thumb) {
    // Uploaded before thumbnails existed: building one is a full decode, so it
    // takes a slot like an upload does.
    const release = tryAcquireDecodeSlot()
    if (!release) {
      res.set("Retry-After", "5")
      throw new UploadBusyError()
    }
    try {
      thumb = await buildMissingThumb(userId, photoId)
    } finally {
      release()
    }
  }
  res.set("Content-Type", "image/jpeg")
  res.set("Content-Disposition", "inline")
  res.set("Cache-Control", `private, max-age=${86_400}`)
  res.send(thumb)
})

router.delete("/:id", async (req: Request, res: Response) => {
  const photoId = parseIntParam(String(req.params.id), "photo ID")
  await deletePhoto(req.user!.id, photoId)
  res.json({ success: true })
})

export default router
