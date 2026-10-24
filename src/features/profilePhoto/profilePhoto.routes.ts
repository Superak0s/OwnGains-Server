import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { userRateLimit } from "@/middleware/userRateLimit.js"
import { parseUuidParam } from "@/middleware/validation.js"
import { photoUpload, assertImageUpload, uploadSlot } from "@/middleware/imageUpload.js"
import {
  setProfilePhoto,
  getProfilePhoto,
  getVisibleProfilePhoto,
  deleteProfilePhoto,
} from "./profilePhoto.model.js"

const router: Router = Router()

router.use(authenticateToken)

const uploadLimiter = userRateLimit(
  "profile-photo",
  15 * 60 * 1000,
  20,
  "Too many profile photo uploads, please try again later",
)

router.put(
  "/",
  uploadLimiter,
  uploadSlot,
  photoUpload.single("photo"),
  async (req: Request, res: Response) => {
    assertImageUpload(req.file)
    const hash = await setProfilePhoto(req.user!.id, req.file.buffer)
    res.json({ success: true, data: { hash } })
  },
)

function sendPhoto(req: Request, res: Response, { data, hash }: { data: Buffer; hash: string }) {
  const etag = `"${hash}"`
  res.set("ETag", etag)
  res.set("Cache-Control", "private, no-cache")
  const ifNoneMatch = req.get("If-None-Match")
  if (ifNoneMatch?.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    res.status(304).end()
    return
  }
  res.set("Content-Type", "image/jpeg")
  res.set("Content-Disposition", "inline")
  res.send(data)
}

router.get("/", async (req: Request, res: Response) => {
  sendPhoto(req, res, await getProfilePhoto(req.user!.id))
})

router.get("/:userUuid", async (req: Request, res: Response) => {
  const uuid = parseUuidParam(req.params.userUuid, "user id")
  sendPhoto(req, res, await getVisibleProfilePhoto(req.user!.id, uuid))
})

router.delete("/", async (req: Request, res: Response) => {
  await deleteProfilePhoto(req.user!.id)
  res.json({ success: true })
})

export default router
