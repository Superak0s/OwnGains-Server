import { envInt } from "../config/env.js"

const port = envInt("PORT", 5100)

/** Marketplace settings, read once at startup. */
export const marketplaceConfig = {
  port,
  authServerUrl: (process.env.AUTH_SERVER_URL || "https://owngains.superak0s.com").replace(/\/+$/, ""),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
  downloadSalt: process.env.DOWNLOAD_SALT ?? "",
  // Same rule as the server: 1 behind a TLS-terminating proxy, 0 when exposed directly.
  trustProxyHops: envInt("TRUST_PROXY_HOPS", 0),
}
