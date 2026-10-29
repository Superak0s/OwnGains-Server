import { marketplaceConfig } from "./env.js"
import type { SkinSummary } from "./skins.model.js"

const PLAY_URL = "https://play.google.com/store/apps/details?id=com.owngains.app"
const RELEASES_URL = "https://github.com/Superak0s/OwnGains-App/releases/latest"

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const STYLE = `body{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center}
main{max-width:480px;width:100%;padding:24px 16px}h1{margin:0 0 4px;font-size:1.6rem;overflow-wrap:anywhere}
.muted{color:#94a3b8}.swatch{display:flex;height:40px;border-radius:12px;overflow:hidden;margin:16px 0}.swatch span{flex:1}
.btn{display:block;text-align:center;padding:12px;border-radius:10px;margin:8px 0;text-decoration:none;font-weight:600;border:0;font-size:1rem;width:100%;box-sizing:border-box}
.primary{background:#6366f1;color:#fff}.secondary{background:#1e293b;color:#e2e8f0}code{background:#1e293b;padding:2px 6px;border-radius:6px}`

function shell(title: string, body: string, nonce?: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${nonce ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`
}

/** The share page for one skin. Every user-supplied string is escaped. */
export function renderSkinPage(skin: SkinSummary, publicUrl: string, nonce: string): string {
  const stars = skin.rating.average === null ? "No ratings yet" : `${skin.rating.average} ★ (${skin.rating.count})`
  const contents = [skin.hasTheme && "Theme", skin.hasBoards && "Widget layouts"].filter(Boolean).join(" and ")
  const deepLink = `owngains://skin/${skin.id}?m=${encodeURIComponent(publicUrl)}`
  const swatch = skin.swatch.length
    ? `<div class="swatch">${skin.swatch.map((c) => `<span style="background:${esc(c)}"></span>`).join("")}</div>`
    : ""
  const body = `<h1>${esc(skin.name)}</h1>
<p class="muted">by ${esc(skin.author ?? "Deleted user")} · ${stars}</p>
<p class="muted">${skin.downloads} downloads · ${skin.uniqueDownloads} unique</p>
${swatch}
${skin.description ? `<p>${esc(skin.description)}</p>` : ""}
<p>Contains: ${contents}</p>
<p>Skin ID <code>${skin.id}</code> <button id="copy" class="btn secondary" type="button">Copy ID</button></p>
<a class="btn primary" href="${esc(deepLink)}">Open in OwnGains</a>
<p class="muted">Don't have the app?</p>
<a class="btn secondary" href="${PLAY_URL}">Get it on Google Play</a>
<a class="btn secondary" href="${RELEASES_URL}">Download the APK from GitHub</a>${
    marketplaceConfig.reportEmail
      ? `\n<p class="muted"><a href="mailto:${esc(marketplaceConfig.reportEmail)}?subject=${encodeURIComponent(`Report skin ${skin.id}`)}" style="color:inherit">Report this skin</a>, no account needed.</p>`
      : ""
  }`
  const script = `document.getElementById("copy").onclick=function(){navigator.clipboard.writeText("${skin.id}");this.textContent="Copied"}`
  return shell(`${skin.name} · OwnGains skin`, body, nonce, script)
}

export function renderNotFoundPage(): string {
  return shell("Skin not found", `<h1>Skin not found</h1><p class="muted">It was deleted or never existed.</p>`)
}
