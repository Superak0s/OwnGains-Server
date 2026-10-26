import { randomBytes } from "node:crypto"
import express from "express"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import { version } from "../config/version.js"
import { errorHandler } from "../middleware/errorHandler.js"
import { marketplaceConfig } from "./env.js"
import { meRouter } from "./me.routes.js"
import { renderNotFoundPage, renderSkinPage } from "./page.js"
import { findSkin } from "./skins.model.js"
import { skinsRouter } from "./skins.routes.js"

/** The marketplace Express app, exported for tests. */
export const app = express()

app.set("trust proxy", marketplaceConfig.trustProxyHops)
app.disable("x-powered-by")
app.use(helmet())

const skipUnderTests = () => !!process.env.VITEST

app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipUnderTests,
    message: { success: false, error: "Too many requests, please try again later" },
  }),
)

// After the limiters, so an anonymous caller can't buy JSON.parse CPU. 64KB skin plus its envelope.
app.use(express.json({ limit: "80kb" }))

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", version, authServer: new URL(marketplaceConfig.authServerUrl).origin })
})

app.use("/api/skins", skinsRouter)
app.use("/api/me", meRouter)

app.get("/skins/:id", async (req, res) => {
  const nonce = randomBytes(16).toString("base64")
  res.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
  )
  const id = /^\d{1,10}$/.test(req.params.id) ? Number(req.params.id) : 0
  const skin = id ? await findSkin(id) : null
  if (!skin) return void res.status(404).type("html").send(renderNotFoundPage())
  res.type("html").send(renderSkinPage(skin, marketplaceConfig.publicUrl, nonce))
})

app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Not found" })
})

app.use(errorHandler)
