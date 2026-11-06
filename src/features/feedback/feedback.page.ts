import { Router, Request, Response } from "express"
import { randomBytes } from "node:crypto"

/**
 * GET /admin/feedback: the inbox over /api/admin/feedback. Same security model
 * as /admin/metrics (static page, Bearer token in sessionStorage, nonce CSP),
 * and the same sessionStorage keys, so one sign-in covers both pages.
 */
const router: Router = Router()

router.get("/", (_req: Request, res: Response) => {
  const nonce = randomBytes(16).toString("base64")
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  )
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.type("html").send(PAGE.replaceAll("__NONCE__", nonce))
})

export default router

const PAGE = /* html */ String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>OwnGains Feedback</title>
<style nonce="__NONCE__">
:root { color-scheme: light dark; --border: #8884; --muted: #888; --accent: #2a78d6; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 900px; padding: 16px; }
.hidden { display: none !important; }
form { display: grid; gap: 8px; max-width: 320px; }
input, select, button { font: inherit; padding: 6px 10px; }
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.bar h1 { margin: 0 auto 0 0; font-size: 20px; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.card.new { border-left: 4px solid var(--accent); }
.meta { color: var(--muted); font-size: 12px; }
.msg { white-space: pre-wrap; margin: 8px 0; }
.kind { font-weight: 600; text-transform: uppercase; font-size: 11px; margin-right: 6px; }
.actions { display: flex; gap: 6px; }
.error { color: #cf222e; }
</style>
</head>
<body>
<section id="login" class="hidden">
  <h1>OwnGains Feedback</h1>
  <form id="login-form">
    <label for="username">Username or email</label>
    <input id="username" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <div class="error" id="login-error" role="alert"></div>
  </form>
</section>
<div id="app" class="hidden">
  <div class="bar">
    <h1>Feedback</h1>
    <label for="status" class="meta">Show</label>
    <select id="status">
      <option value="">All</option>
      <option value="new" selected>New</option>
      <option value="read">Read</option>
      <option value="done">Done</option>
    </select>
    <button id="reload" type="button">Refresh</button>
    <button id="signout" type="button">Sign out</button>
  </div>
  <div class="error" id="app-error" role="alert"></div>
  <div id="list"></div>
</div>
<script nonce="__NONCE__">
(() => {
  "use strict"
  const $ = (id) => document.getElementById(id)
  const store = {
    get(k) { try { return sessionStorage.getItem(k) } catch { return null } },
    set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v) } catch {} },
  }
  let token = store.get("ol_token")
  let refreshToken = store.get("ol_refresh")

  function saveTokens(t, r) {
    token = t || null
    refreshToken = r || null
    store.set("ol_token", token)
    store.set("ol_refresh", refreshToken)
  }
  function showLogin(message) {
    $("app").classList.add("hidden")
    $("login").classList.remove("hidden")
    $("login-error").textContent = message || ""
  }
  async function tryRefresh() {
    if (!refreshToken) return false
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => null)
    if (!res || !res.ok) { saveTokens(null, null); return false }
    const body = await res.json()
    saveTokens(body.token, body.refreshToken)
    return true
  }
  async function api(method, path, body) {
    const call = () => fetch(path, {
      method,
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null)
    let res = await call()
    if (res && res.status === 401 && (await tryRefresh())) res = await call()
    return res
  }
  function signOut(message) {
    const t = token, r = refreshToken
    saveTokens(null, null)
    if (t && r)
      fetch("/api/auth/signout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
        body: JSON.stringify({ refreshToken: r }),
      }).catch(() => {})
    showLogin(message)
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function button(label, onClick) {
    const b = el("button", null, label)
    b.type = "button"
    b.addEventListener("click", onClick)
    return b
  }
  async function act(method, id, body) {
    const res = await api(method, "/api/admin/feedback/" + id, body)
    if (!res || !res.ok) $("app-error").textContent = "Action failed" + (res ? " (HTTP " + res.status + ")" : "") + "."
    load()
  }
  function render(items) {
    const list = $("list")
    list.replaceChildren()
    if (!items.length) list.append(el("p", "meta", "Nothing here."))
    for (const f of items) {
      const card = el("div", "card " + f.status)
      const head = el("div")
      head.append(el("span", "kind", f.kind))
      const who = f.user ? f.user.username : "anonymous"
      const device = [f.platform, f.osVersion, f.appVersion && "v" + f.appVersion].filter(Boolean).join(" · ")
      head.append(el("span", "meta", new Date(f.createdAt).toLocaleString() + " · " + who + (device ? " · " + device : "") + " · " + f.status))
      card.append(head, el("div", "msg", f.message))
      if (f.contact) card.append(el("div", "meta", "Contact: " + f.contact))
      const actions = el("div", "actions")
      for (const s of ["new", "read", "done"])
        if (s !== f.status) actions.append(button("Mark " + s, () => act("PATCH", f.id, { status: s })))
      actions.append(button("Delete", () => { if (confirm("Delete this feedback?")) act("DELETE", f.id) }))
      card.append(actions)
      list.append(card)
    }
  }
  async function load() {
    if (!token) return showLogin()
    const status = $("status").value
    const res = await api("GET", "/api/admin/feedback" + (status ? "?status=" + status : ""))
    if (!res) return void ($("app-error").textContent = "Server unreachable.")
    if (res.status === 401) return showLogin("Session expired. Sign in again.")
    if (res.status === 403) return signOut("This account is not an admin.")
    if (!res.ok) return void ($("app-error").textContent = "Could not load feedback (HTTP " + res.status + ").")
    $("app-error").textContent = ""
    $("login").classList.add("hidden")
    $("app").classList.remove("hidden")
    render((await res.json()).feedback)
  }
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault()
    $("login-error").textContent = ""
    const res = await fetch("/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("username").value.trim(), password: $("password").value }),
    }).catch(() => null)
    if (!res) return void ($("login-error").textContent = "Server unreachable.")
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return void ($("login-error").textContent = body.error || "Sign-in failed (HTTP " + res.status + ").")
    $("password").value = ""
    saveTokens(body.token, body.refreshToken)
    if (!body.user || !body.user.isAdmin) return signOut("This account is not an admin.")
    load()
  })
  $("status").addEventListener("change", load)
  $("reload").addEventListener("click", load)
  $("signout").addEventListener("click", () => signOut())
  load()
})()
</script>
</body>
</html>`
