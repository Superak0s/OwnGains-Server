import multer from "multer"
import type { Request, Response, NextFunction } from "express"
import { AppError, ValidationError } from "./errorHandler.js"

// Transport-level gate for /api/tracking/photos/muscle uploads. The model
// still enforces its own narrower mime list.
// Kept in sync with the model's list deliberately: multer accepting a type the
// model rejects meant a 10 MB GIF was uploaded in full and then 400'd.
const ALLOWED_MIMETYPES = new Set(["image/jpeg", "image/png", "image/webp"])

export const photoUpload = multer({
  storage: multer.memoryStorage(),
  // Every limit, not just fileSize: busboy's defaults are unlimited fields and
  // parts at 1 MiB each, all buffered into req.body before any handler runs, and
  // the 50 kb JSON cap never sees multipart. The upload form is one file plus
  // five short text fields (muscleGroups, takenAt, note, angle, customSideName).
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
    files: 1,
    fields: 8,
    fieldSize: 4096,
    parts: 10,
    fieldNameSize: 64,
    headerPairs: 50,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) cb(null, true)
    else cb(new ValidationError("Only JPEG, PNG, or WebP images are allowed"))
  },
})

// Content-Type is client-supplied and unverified, so check the magic bytes.
function matchesImageSignature(mimetype: string, buf: Buffer): boolean {
  switch (mimetype) {
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case "image/png":
      return buf
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case "image/gif":
      return (
        buf.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buf.subarray(0, 6).toString("ascii") === "GIF89a"
      )
    case "image/webp":
      return (
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
      )
    default:
      return false
  }
}

/** Throws unless `file` is present and its bytes match its declared type. */
export function assertImageUpload(
  file: Express.Multer.File | undefined,
): asserts file is Express.Multer.File {
  if (!file) throw new ValidationError("No photo file provided")
  if (!matchesImageSignature(file.mimetype, file.buffer))
    throw new ValidationError("File content does not match declared image type")
}

// ─── Decode slots ─────────────────────────────────────────────────────────────
//
// A photo upload holds up to 10 MB of body in memory and then a sharp decode of
// up to 40 MP (see progressPhoto.model.ts). Two at a time is what a small box
// carries without starving everything else of memory and of the libuv pool
// sharp shares with gzip, fs and DNS. Past that a caller gets 503 + Retry-After
// instead of a place in an unbounded queue. In-process state, like every other
// limiter here: the server is single-instance.
export const MAX_CONCURRENT_DECODES = 2
let decodesInFlight = 0

export class UploadBusyError extends AppError {
  constructor() {
    super("Server is busy processing other photos; retry shortly", 503, null, "UPLOAD_BUSY")
  }
}

/** Decode slots currently held, for the admin metrics page. */
export function decodesInUse(): number {
  return decodesInFlight
}

/** Claim a decode slot, or null when all are taken. The release is idempotent. */
export function tryAcquireDecodeSlot(): (() => void) | null {
  if (decodesInFlight >= MAX_CONCURRENT_DECODES) return null
  decodesInFlight++
  let released = false
  return () => {
    if (released) return
    released = true
    decodesInFlight--
  }
}

/**
 * Route middleware, mounted *before* multer so a busy server refuses the
 * request without buffering its body. The slot is held until the response
 * finishes or the socket closes, whichever comes first.
 */
export function uploadSlot(_req: Request, res: Response, next: NextFunction): void {
  const release = tryAcquireDecodeSlot()
  if (!release) {
    res.set("Retry-After", "5")
    throw new UploadBusyError()
  }
  res.once("finish", release)
  res.once("close", release)
  next()
}
