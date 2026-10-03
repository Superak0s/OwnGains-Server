import { Router, Request, Response, NextFunction } from "express"
import { logger } from "@/utils/logger.js"

// The official server's Privacy Policy, Terms and account-deletion page, for
// the Play listing and the app's links. Fetched from OwnGains-App/docs/ on
// GitHub (the app shows the same text in-app), so there is one copy to edit.
// They name the official server's controller, so only LEGAL_PAGES_ENABLED
// instances serve them: a self-hosted box must not publish someone else's
// policy as its own.
const PAGES = new Set(["privacy-policy", "terms-of-service", "delete-account"])
const TTL_MS = 60 * 60 * 1000

const baseUrl = (): string =>
  process.env.LEGAL_PAGES_URL ??
  "https://raw.githubusercontent.com/Superak0s/OwnGains-App/main/docs/"

const cache = new Map<string, { html: string; at: number }>()

// ponytail: concurrent misses each fetch. Fine at this traffic, dedupe with an
// in-flight promise if it ever isn't.
async function load(page: string): Promise<string | null> {
  const hit = cache.get(page)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.html
  try {
    const res = await fetch(new URL(`${page}.html`, baseUrl()), {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    cache.set(page, { html, at: Date.now() })
    return html
  } catch (err) {
    // GitHub down: keep serving the last good copy rather than nothing.
    logger.warn(`Legal page ${page} fetch failed: ${(err as Error).message}`)
    return hit?.html ?? null
  }
}

const router: Router = Router()

router.get("/:page.html", async (req: Request, res: Response, next: NextFunction) => {
  const page = String(req.params.page)
  if (!PAGES.has(page)) return next()
  const html = await load(page)
  if (html === null)
    return res.status(503).set("Retry-After", "60").json({ error: "Page unavailable" })
  // Static text with one inline <style> and no scripts: relax helmet's
  // `default-src 'none'` just enough for the style to apply. Also blocks any
  // script that ever appears in the fetched file.
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  res.set("Cache-Control", "public, max-age=3600")
  res.type("html").send(html)
})

export default router
