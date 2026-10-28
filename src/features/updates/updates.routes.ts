import { Router, Request, Response } from "express"
import { randomBytes } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { AppError, ValidationError } from "@/middleware/errorHandler.js"

// Over-the-air JS updates for the app (expo-updates protocol v1). Each update
// is built and signed on the publisher's machine and copied into
// UPDATES_DIR/<runtimeVersion>/<channel>/<stamp>/, so this server never holds
// the signing key: it picks the newest <stamp> and wraps its two files.
// Mounted ahead of the /api limiters and the request log (every launch checks,
// and the privacy policy says the check stores nothing).
const RUNTIME = /^[0-9a-f]+$/
const STAMP = /^[0-9TZ-]+$/
const CHANNELS = new Set(["play", "github"])

const updatesDir = (): string | undefined =>
  process.env.UPDATES_DIR ? path.resolve(process.env.UPDATES_DIR) : undefined

/** The newest `<stamp>` directory name, or undefined when there is none. */
async function newestStamp(dir: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    // ISO timestamps with ':' and '.' replaced by '-' sort lexicographically.
    return entries
      .filter((e) => e.isDirectory() && STAMP.test(e.name))
      .map((e) => e.name)
      .sort()
      .at(-1)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

const router: Router = Router()

router.get("/manifest", async (req: Request, res: Response) => {
  res.set({ "expo-protocol-version": "1", "expo-sfv-version": "0" })
  const root = updatesDir()
  if (!root) return res.status(204).end()

  if (req.get("expo-protocol-version") !== "1")
    throw new AppError("Unsupported expo-protocol-version", 406)
  if (req.get("expo-platform") !== "android")
    throw new ValidationError("expo-platform must be android")
  const runtime = req.get("expo-runtime-version") ?? ""
  if (!RUNTIME.test(runtime)) throw new ValidationError("Invalid expo-runtime-version")
  const channel = req.get("expo-channel-name") ?? ""
  if (!CHANNELS.has(channel)) throw new ValidationError("Invalid expo-channel-name")

  const channelDir = path.join(root, runtime, channel)
  const stamp = await newestStamp(channelDir)
  if (!stamp) return res.status(204).end()

  const dir = path.join(channelDir, stamp)
  // The signature covers these exact bytes, so the manifest is never parsed.
  const [manifest, signature] = await Promise.all([
    readFile(path.join(dir, "manifest.json")),
    readFile(path.join(dir, "expo-signature"), "utf8"),
  ])
  const boundary = randomBytes(16).toString("hex")
  const head =
    `--${boundary}\r\n` +
    `content-disposition: form-data; name="manifest"\r\n` +
    `content-type: application/json; charset=utf-8\r\n` +
    // Trimmed: a trailing newline from the file would end the header early.
    `expo-signature: ${signature.trim()}\r\n\r\n`
  res
    .status(200)
    .set("cache-control", "private, max-age=0")
    .type(`multipart/mixed; boundary=${boundary}`)
    .send(Buffer.concat([Buffer.from(head), manifest, Buffer.from(`\r\n--${boundary}--\r\n`)]))
})

router.get(
  "/assets/:runtimeVersion/:channel/:stamp/*file",
  (req: Request, res: Response) => {
    const notFound = () => res.status(404).json({ success: false, error: "Route not found" })
    const root = updatesDir()
    const { runtimeVersion, channel, stamp } = req.params as Record<string, string>
    const segments = req.params.file as unknown as string[]
    if (
      !root ||
      !RUNTIME.test(runtimeVersion) ||
      !CHANNELS.has(channel) ||
      !STAMP.test(stamp)
    )
      return notFound()
    const base = path.join(root, runtimeVersion, channel, stamp)
    const file = path.resolve(base, ...segments)
    const rel = path.relative(base, file)
    if (
      !file.startsWith(base + path.sep) ||
      rel === "manifest.json" ||
      rel === "expo-signature"
    )
      return notFound()
    // Every update is a new directory, so a file never changes under its URL.
    res.sendFile(file, { maxAge: "1y", immutable: true }, (err) => {
      if (err && !res.headersSent) notFound()
    })
  },
)

export default router
