import { Router, Request, Response } from "express"
import { randomBytes } from "node:crypto"

/**
 * GET /admin/metrics: a self-contained dashboard over GET /api/admin/metrics.
 *
 * The page itself is public and contains no data: it is a sign-in form plus the
 * script that renders the JSON. The browser signs in through the ordinary
 * POST /api/auth/signin (so the credential limiter and per-account throttle
 * apply unchanged) and every read sends the resulting Bearer token, which
 * requireAdmin checks. A non-admin gets the 403 and nothing else.
 *
 * Tokens are kept in sessionStorage (gone when the tab closes), and "Sign out"
 * revokes the refresh token server-side. No cookie is ever set, so there is
 * no CSRF surface: another origin can load this page but can't read the
 * token out of it, and the API ignores ambient credentials entirely.
 *
 * helmet's global CSP is `default-src 'none'`, and this one response relaxes it
 * to exactly what the page needs: its own inline script and style (by a
 * per-response nonce) and fetches back to this origin.
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
      "img-src data:",
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
<title>OwnGains Metrics</title>
<style nonce="__NONCE__">
:root {
  color-scheme: light;
  --bg: #f4f4f2; --surface: #fcfcfb; --surface-2: #f0efec; --border: #e3e2de;
  --text: #0b0b0b; --text-2: #52514e; --muted: #7a7974;
  --accent: #2a78d6; --series-1: #2a78d6; --grid: #ebeae6;
  --good: #1a7f37; --warn: #9a6700; --bad: #cf222e;
  --input: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #111110; --surface: #1a1a19; --surface-2: #232321; --border: #2e2e2b;
    --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8e86;
    --accent: #3987e5; --series-1: #3987e5; --grid: #2a2a27;
    --good: #3fb950; --warn: #d29922; --bad: #f85149;
    --input: #111110;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111110; --surface: #1a1a19; --surface-2: #232321; --border: #2e2e2b;
  --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8e86;
  --accent: #3987e5; --series-1: #3987e5; --grid: #2a2a27;
  --good: #3fb950; --warn: #d29922; --bad: #f85149;
  --input: #111110;
}
* { box-sizing: border-box; }
html { scroll-padding-top: 110px; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  padding: 12px 16px 0; border-bottom: 1px solid var(--border); background: var(--surface);
  position: sticky; top: 0; z-index: 2;
}
.bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
header h1 { font-size: 17px; margin: 0; }
.meta { color: var(--muted); font-size: 12px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
nav { display: flex; gap: 2px; overflow-x: auto; margin-top: 8px; scrollbar-width: none; }
nav a {
  color: var(--text-2); text-decoration: none; font-size: 13px; padding: 6px 10px 8px;
  border-bottom: 2px solid transparent; white-space: nowrap;
}
nav a:hover { color: var(--text); border-bottom-color: var(--border); }
nav a .count { margin-left: 4px; }
main { max-width: 1280px; margin: 0 auto; padding: 16px; }
button, select, input {
  font: inherit; color: var(--text); background: var(--input);
  border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px;
}
button { cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.chip { padding: 3px 10px; border-radius: 14px; font-size: 12px; }
button.chip[aria-pressed="true"] { background: var(--text); color: var(--surface); border-color: var(--text); }
.login {
  max-width: 360px; margin: 10vh auto; background: var(--surface);
  border: 1px solid var(--border); border-radius: 10px; padding: 24px;
}
.login h1 { font-size: 18px; margin: 0 0 4px; }
.login p { color: var(--text-2); margin: 0 0 16px; }
.login label { display: block; font-size: 12px; color: var(--text-2); margin: 10px 0 4px; }
.login input { width: 100%; }
.login button { width: 100%; margin-top: 16px; }
.error { color: var(--bad); min-height: 1.4em; margin-top: 10px; font-size: 13px; }
#app-error:empty { display: none; }
.hidden { display: none !important; }
section { margin-bottom: 8px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); margin: 28px 0 10px; }
h3 { font-size: 13px; color: var(--text-2); margin: 18px 0 8px; font-weight: 600; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 10px; }
.toolbar input[type=search] { min-width: 220px; flex: 1; max-width: 360px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.tile .label { font-size: 12px; color: var(--text-2); }
.tile .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
.tile .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
.tile.bad .value { color: var(--bad); } .tile.warn .value { color: var(--warn); }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.chart { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; position: relative; }
.chart .title { font-size: 13px; font-weight: 600; }
.chart .now { font-size: 12px; color: var(--muted); }
.chart svg { display: block; width: 100%; height: auto; margin-top: 8px; overflow: visible; }
.chart .grid { stroke: var(--grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart .axis { fill: var(--muted); font-size: 9px; }
.chart .bar { fill: var(--series-1); }
.chart .line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.chart .cross { stroke: var(--muted); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart .hit { fill: transparent; }
.chart .empty { color: var(--muted); font-size: 12px; aspect-ratio: 320 / 120; display: flex; align-items: center; justify-content: center; }
.tip {
  position: absolute; pointer-events: none; background: var(--text); color: var(--surface);
  font-size: 12px; padding: 4px 8px; border-radius: 4px; white-space: nowrap; transform: translate(-50%, -110%);
}
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; }
/* Long lists scroll inside their card (header row stays put) instead of
   pushing every later section a screen further down. */
#recent-client .panel, #recent-server, #log-errors, #slow .panel, #db-tables .panel { max-height: 440px; overflow: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; vertical-align: top; }
th { font-size: 12px; color: var(--text-2); font-weight: 600; position: sticky; top: 0; background: var(--surface); }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--text); }
th .dir { font-size: 10px; margin-left: 3px; }
td.num, th.num { text-align: right; }
td.wrap { white-space: normal; min-width: 240px; max-width: 520px; overflow-wrap: anywhere; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--surface-2); }
code { font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0; }
.kv div { display: flex; justify-content: space-between; gap: 12px; padding: 7px 12px; border-bottom: 1px solid var(--border); }
.kv span:first-child { color: var(--text-2); }
.kv span:last-child { font-variant-numeric: tabular-nums; text-align: right; }
.badge {
  display: inline-block; min-width: 38px; text-align: center; padding: 0 6px; border-radius: 10px;
  font-size: 12px; font-weight: 600; border: 1px solid currentColor; font-variant-numeric: tabular-nums;
}
.badge.good { color: var(--good); } .badge.warn { color: var(--warn); } .badge.bad { color: var(--bad); } .badge.neutral { color: var(--text-2); }
.statuses { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.statuses span.item { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; font-size: 12px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
details.event { border-bottom: 1px solid var(--border); }
details.event:last-child { border-bottom: 0; }
details.event summary {
  list-style: none; cursor: pointer; padding: 8px 12px; display: grid;
  grid-template-columns: 100px 52px minmax(160px, 1.2fr) minmax(200px, 2fr) 90px; gap: 12px; align-items: baseline;
}
details.event summary::-webkit-details-marker { display: none; }
details.event summary:hover { background: var(--surface-2); }
details.event summary > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details.event[open] summary { background: var(--surface-2); }
details.event .body { padding: 8px 12px 12px; }
pre {
  margin: 8px 0 0; padding: 10px; background: var(--surface-2); border-radius: 6px; overflow-x: auto;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
}
.empty-state { padding: 14px 12px; color: var(--muted); font-size: 13px; }
.warnings { color: var(--warn); font-size: 13px; }
@media (max-width: 700px) {
  details.event summary { grid-template-columns: 92px 48px 1fr; }
  details.event summary > :nth-child(4), details.event summary > :nth-child(5) { display: none; }
  .charts { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<section id="login" class="login hidden">
  <h1>OwnGains Metrics</h1>
  <p>Sign in with an admin account of this server.</p>
  <form id="login-form" autocomplete="on">
    <label for="username">Username or email</label>
    <input id="username" name="username" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button class="primary" type="submit">Sign in</button>
    <div class="error" id="login-error" role="alert"></div>
  </form>
</section>

<div id="app" class="hidden">
  <header>
    <div class="bar">
      <div>
        <h1>OwnGains Metrics</h1>
        <div class="meta" id="meta">Loading…</div>
      </div>
      <div class="controls">
        <label class="meta" for="window">Show</label>
        <select id="window">
          <option value="15m">Last 15 min</option>
          <option value="1h" selected>Last hour</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">Since restart</option>
          <option value="custom">Custom range</option>
        </select>
        <span id="custom-range" class="controls hidden">
          <input type="datetime-local" id="from" aria-label="From">
          <span class="meta">to</span>
          <input type="datetime-local" id="to" aria-label="To">
        </span>
        <label class="meta" for="interval">Refresh</label>
        <select id="interval">
          <option value="0">Off</option>
          <option value="5000">5s</option>
          <option value="15000" selected>15s</option>
          <option value="60000">1m</option>
        </select>
        <button id="refresh" type="button" title="F5 refreshes the data too">Refresh now</button>
        <button id="signout" type="button">Sign out</button>
      </div>
    </div>
    <nav aria-label="Sections">
      <a href="#s-overview">Overview</a>
      <a href="#s-errors">Errors<span class="count badge neutral" id="nav-errors">0</span></a>
      <a href="#s-performance">Performance</a>
      <a href="#s-routes">Routes</a>
      <a href="#s-slow">Slow requests</a>
      <a href="#s-users">Users</a>
      <a href="#s-system">System</a>
      <a href="#s-database">Database</a>
      <a href="#s-config">Config</a>
    </nav>
  </header>
  <main>
    <div class="error" id="app-error" role="alert"></div>

    <section id="s-overview"><h2>Overview</h2><div id="overview"></div></section>

    <section id="s-errors">
      <h2>Errors</h2>
      <div id="error-tiles"></div>
      <h3>Responses by status code</h3>
      <div class="statuses" id="status-codes"></div>
      <h3>Error kinds</h3>
      <div class="toolbar">
        <button class="chip" type="button" data-errfilter="all" aria-pressed="true">All</button>
        <button class="chip" type="button" data-errfilter="5xx" aria-pressed="false">5xx</button>
        <button class="chip" type="button" data-errfilter="4xx" aria-pressed="false">4xx</button>
        <button class="chip" type="button" data-errfilter="429" aria-pressed="false">Rate limited</button>
        <button class="chip" type="button" data-errfilter="auth" aria-pressed="false">Auth (401/403)</button>
        <input type="search" id="err-search" placeholder="Filter by message, code or route" aria-label="Filter errors">
        <button type="button" id="clear-errors">Clear error log</button>
      </div>
      <p class="meta hidden" id="lists-from"></p>
      <div id="error-groups"></div>
      <h3>Recent server errors (5xx)</h3>
      <div class="panel" id="recent-server"></div>
      <h3>Recent client errors (4xx)</h3>
      <div id="recent-client"></div>
      <h3>Server error log</h3>
      <div class="panel" id="log-errors"></div>
    </section>

    <section id="s-performance">
      <h2>Performance</h2>
      <div id="latency-tiles"></div>
      <h3 id="chart-title">Per minute</h3>
      <div class="charts" id="charts"></div>
    </section>

    <section id="s-routes">
      <h2>Routes</h2>
      <div class="toolbar">
        <input type="search" id="route-search" placeholder="Filter routes" aria-label="Filter routes">
        <span class="meta">Since restart, whatever the window. Click a column to sort. Ids in paths are collapsed to :id.</span>
      </div>
      <div id="routes"></div>
    </section>

    <section id="s-slow"><h2>Slow requests</h2><div id="slow"></div></section>
    <section id="s-users"><h2>Users &amp; activity</h2><div id="users"></div></section>
    <section id="s-system"><h2>System</h2><div id="system"></div></section>
    <section id="s-database"><h2>Database</h2><div id="database"></div></section>
    <section id="s-config"><h2>Configuration</h2><div id="config"></div></section>
  </main>
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
  let timer = null
  let data = null
  // View state that must survive the periodic re-render.
  const WINDOW_LABELS = { "15m": "last 15 min", "1h": "last hour", "6h": "last 6 hours", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", all: "since restart", custom: "selected range" }
  const ui = {
    window: WINDOW_LABELS[store.get("ol_window")] ? store.get("ol_window") : "1h",
    errFilter: "all", errSearch: "", routeSearch: "",
    routeSort: { key: "count", dir: -1 },
    dbSort: { key: "dataMb", dir: -1 },
    from: store.get("ol_from") || "", to: store.get("ol_to") || "",
    open: new Set(),
  }

  function saveTokens(t, r) {
    token = t || null
    if (r !== undefined) refreshToken = r || null
    store.set("ol_token", token)
    store.set("ol_refresh", refreshToken)
  }

  function showLogin(message) {
    clearInterval(timer)
    $("app").classList.add("hidden")
    $("login").classList.remove("hidden")
    $("login-error").textContent = message || ""
    $("username").focus()
  }

  function showApp() {
    $("login").classList.add("hidden")
    $("app").classList.remove("hidden")
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

  // An authenticated call, renewing the access token once on 401.
  async function api(method, path) {
    const call = () => fetch(path, { method, headers: { Authorization: "Bearer " + token } }).catch(() => null)
    let res = await call()
    if (res && res.status === 401 && (await tryRefresh())) res = await call()
    return res
  }

  async function signOut(message) {
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

  async function load() {
    if (!token) return showLogin()
    let query = "?window=" + encodeURIComponent(ui.window)
    if (ui.window === "custom") {
      // datetime-local values are local time, which new Date reads as such.
      const from = new Date(ui.from), to = new Date(ui.to)
      if (!(from < to)) { $("app-error").textContent = "Pick a start and an end date, the start first."; return }
      query += "&from=" + encodeURIComponent(from.toISOString()) + "&to=" + encodeURIComponent(to.toISOString())
    }
    const res = await api("GET", "/api/admin/metrics" + query)
    if (!res) { $("app-error").textContent = "Server unreachable, retrying."; return }
    if (res.status === 401) return showLogin("Session expired. Sign in again.")
    if (res.status === 403) return signOut("This account is not an admin.")
    if (!res.ok) { $("app-error").textContent = "Could not load metrics (HTTP " + res.status + ")."; return }
    $("app-error").textContent = ""
    showApp()
    data = await res.json()
    // The pickers reach back to the oldest kept data and no further than now.
    for (const id of ["from", "to"]) {
      $(id).min = localInput(new Date(data.window.dataFrom))
      $(id).max = localInput(new Date())
    }
    render()
  }

  function schedule() {
    clearInterval(timer)
    const ms = Number($("interval").value)
    if (ms > 0) timer = setInterval(load, ms)
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
    if (!res.ok) return void ($("login-error").textContent = body.error || ("Sign-in failed (HTTP " + res.status + ")."))
    $("password").value = ""
    saveTokens(body.token, body.refreshToken)
    if (!body.user || !body.user.isAdmin) return signOut("This account is not an admin.")
    await load()
    schedule()
  })
  $("interval").addEventListener("change", schedule)
  const localInput = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const showRange = () => {
    $("custom-range").classList.toggle("hidden", ui.window !== "custom")
    if (ui.window !== "custom") return
    if (!ui.from) ui.from = localInput(new Date(Date.now() - 86400000))
    if (!ui.to) ui.to = localInput(new Date())
    $("from").value = ui.from
    $("to").value = ui.to
  }
  $("window").value = ui.window
  showRange()
  $("window").addEventListener("change", (e) => {
    ui.window = e.target.value
    store.set("ol_window", ui.window)
    showRange()
    load()
  })
  for (const id of ["from", "to"])
    $(id).addEventListener("change", (e) => {
      ui[id] = e.target.value
      store.set("ol_" + id, ui[id])
      load()
    })
  // F5 and Ctrl/Cmd+R reload the data, not the page, so the session, open
  // rows and filters remain. Ctrl+F5 and Ctrl+Shift+R still reload the page.
  document.addEventListener("keydown", (e) => {
    const f5 = e.key === "F5" && !e.ctrlKey && !e.metaKey
    const r = (e.key === "r" || e.key === "R") && (e.ctrlKey || e.metaKey) && !e.shiftKey
    if (!(f5 || r) || $("app").classList.contains("hidden")) return
    e.preventDefault()
    load()
  })
  $("refresh").addEventListener("click", load)
  $("signout").addEventListener("click", () => signOut())

  document.querySelectorAll("[data-errfilter]").forEach((b) => b.addEventListener("click", () => {
    ui.errFilter = b.dataset.errfilter
    document.querySelectorAll("[data-errfilter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)))
    if (data) renderErrors()
  }))
  $("err-search").addEventListener("input", (e) => { ui.errSearch = e.target.value.toLowerCase(); if (data) renderErrors() })
  $("route-search").addEventListener("input", (e) => { ui.routeSearch = e.target.value.toLowerCase(); if (data) renderRoutes() })
  $("clear-errors").addEventListener("click", async () => {
    if (!confirm("Clear the recorded errors, slow requests and error log? Counts and charts are kept.")) return
    const res = await api("DELETE", "/api/admin/metrics/errors")
    if (res && res.ok) { ui.open.clear(); load() }
  })
  // Clicking a header sorts by it, clicking it again flips the order. Text
  // columns start A to Z, numbers start largest first.
  const nextSort = (cur, th) => {
    const key = th.dataset.sort
    return { key, dir: cur.key === key ? -cur.dir : (th.classList.contains("num") ? -1 : 1) }
  }
  $("routes").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]")
    if (!th) return
    ui.routeSort = nextSort(ui.routeSort, th)
    renderRoutes()
  })
  $("database").addEventListener("click", (e) => {
    const th = e.target.closest("#db-tables th[data-sort]")
    if (!th) return
    ui.dbSort = nextSort(ui.dbSort, th)
    renderDatabase()
  })
  // Remember which rows are expanded, so a refresh doesn't fold them away.
  document.addEventListener("toggle", (e) => {
    const d = e.target
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.key) return
    if (d.open) ui.open.add(d.dataset.key); else ui.open.delete(d.dataset.key)
  }, true)

  // ─── helpers ────────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
  const fmt = (n, d = 0) => n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d })
  const ms = (n) => n == null ? "—" : fmt(n, n < 10 ? 1 : 0) + " ms"
  const pct = (a, b) => b ? fmt(a / b * 100, 2) + "%" : "—"
  const dur = (s) => {
    if (s == null) return "—"
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60)
    return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m " + (s % 60) + "s"
  }
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000))
    return s < 60 ? s + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago"
  }
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const stamp = (iso) => '<span title="' + esc(new Date(iso).toLocaleString()) + '">' + esc(ago(iso)) + '</span>'
  const badge = (status) => {
    const s = Number(status)
    const cls = s >= 500 ? "bad" : s === 429 ? "warn" : s >= 400 ? "neutral" : s ? "good" : "neutral"
    return '<span class="badge ' + cls + '">' + (s || "—") + '</span>'
  }
  const tile = (label, value, sub, tone) =>
    '<div class="tile' + (tone ? " " + tone : "") + '"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) +
    '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>'
  const tiles = (list) => '<div class="tiles">' + list.join("") + '</div>'
  const kv = (pairs) => '<div class="panel kv">' +
    pairs.map(([k, v]) => '<div><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>').join("") + '</div>'
  const empty = (text) => '<div class="empty-state">' + esc(text) + '</div>'
  // cols: { label, get(row) -> html-safe string, num?, sort? }
  const table = (cols, rows, emptyText, sort) => '<div class="panel"><table><thead><tr>' +
    cols.map((c) => {
      const cls = [c.num ? "num" : "", c.sort ? "sortable" : ""].filter(Boolean).join(" ")
      const dir = sort && c.sort === sort.key ? '<span class="dir">' + (sort.dir > 0 ? "▲" : "▼") + '</span>' : ""
      return '<th' + (cls ? ' class="' + cls + '"' : '') + (c.sort ? ' data-sort="' + c.sort + '" aria-sort="' +
        (dir ? (sort.dir > 0 ? "ascending" : "descending") : "none") + '"' : '') + '>' + esc(c.label) + dir + '</th>'
    }).join("") +
    '</tr></thead><tbody>' + (rows.length ? rows.map((r) => '<tr>' +
      cols.map((c) => '<td class="' + (c.num ? "num" : "") + (c.wrap ? " wrap" : "") + '">' + c.get(r) + '</td>').join("") +
    '</tr>').join("") : '<tr><td colspan="' + cols.length + '"><span class="muted">' + esc(emptyText || "Nothing yet") + '</span></td></tr>') +
    '</tbody></table></div>'

  const sortRows = (rows, { key, dir }) => rows.sort((a, b) => {
    const x = a[key], y = b[key]
    if (x == null) return 1
    if (y == null) return -1
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir
  })

  // One series per chart, one y-axis, so no legend: the title names it.
  function chart(title, points, key, unit, kind) {
    const vals = points.map((p) => p[key])
    const last = [...vals].reverse().find((v) => v != null)
    const head = '<div class="title">' + esc(title) + '</div><div class="now">Latest: ' +
      (last == null ? "—" : fmt(last, 1) + unit) + '</div>'
    if (points.length < 2) return '<div class="chart">' + head + '<div class="empty">Not enough points in this window yet</div></div>'
    const W = 320, H = 120, padL = 34, padB = 4, padT = 6
    const max = Math.max(1, ...vals.filter((v) => v != null)) * 1.1
    // A fixed hour-wide axis, newest minute on the right, so a young process
    // shows a few narrow bars instead of two that fill the chart.
    const SLOTS = data.chart.slots, slot = (W - padL) / SLOTS, offset = Math.max(0, SLOTS - points.length)
    const x = (i) => padL + (offset + i + 0.5) * slot
    const y = (v) => H - padB - (v / max) * (H - padB - padT)
    let marks = ""
    const grid = [0, 0.5, 1].map((f) => {
      const gy = y(max * f)
      return '<line x1="' + padL + '" x2="' + W + '" y1="' + gy + '" y2="' + gy + '" class="grid"/>' +
        '<text x="' + (padL - 4) + '" y="' + (gy + 3) + '" text-anchor="end" class="axis">' + fmt(max * f, max < 10 ? 1 : 0) + '</text>'
    }).join("")
    if (kind === "bar") {
      const bw = Math.max(1, slot - 2)
      marks = vals.map((v, i) => v == null || v === 0 ? "" :
        '<rect x="' + (x(i) - bw / 2) + '" y="' + y(v) + '" width="' + bw + '" height="' + Math.max(0, H - padB - y(v)) +
        '" rx="' + Math.min(2, bw / 2) + '" class="bar"/>').join("")
    } else {
      let d = "", pen = false
      vals.forEach((v, i) => { if (v == null) { pen = false; return } d += (pen ? "L" : "M") + x(i) + " " + y(v); pen = true })
      marks = '<path d="' + d + '" class="line"/>'
    }
    const hits = points.map((p, i) => '<rect class="hit" data-i="' + i + '" x="' + (x(i) - slot / 2) +
      '" y="0" width="' + slot + '" height="' + H + '"/>').join("")
    const pts = esc(JSON.stringify(points.map((p) => [p.at, p[key]])))
    return '<div class="chart" data-unit="' + esc(unit) + '" data-points="' + pts + '">' + head +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title) + ', ' + esc(WINDOW_LABELS[data.window.key]) + '">' +
      grid + marks + '<line class="cross" x1="0" x2="0" y1="0" y2="' + H + '" visibility="hidden"/>' + hits +
      '</svg><div class="tip hidden"></div></div>'
  }

  function wireTooltips(root) {
    root.querySelectorAll(".chart[data-points]").forEach((el) => {
      const pts = JSON.parse(el.dataset.points), unit = el.dataset.unit
      const tip = el.querySelector(".tip"), cross = el.querySelector(".cross"), svg = el.querySelector("svg")
      el.querySelectorAll(".hit").forEach((hit) => {
        hit.addEventListener("mouseenter", () => {
          const [at, v] = pts[Number(hit.dataset.i)]
          const cx = Number(hit.getAttribute("x")) + Number(hit.getAttribute("width")) / 2
          cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible")
          const box = svg.getBoundingClientRect(), host = el.getBoundingClientRect()
          tip.textContent = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + (v == null ? "—" : fmt(v, 1) + unit)
          tip.classList.remove("hidden")
          // Centred on the point, but kept inside the card at either edge.
          const half = tip.offsetWidth / 2
          const left = box.left - host.left + cx / 320 * box.width
          tip.style.left = Math.min(Math.max(left, half + 4), host.width - half - 4) + "px"
          tip.style.top = (box.top - host.top) + "px"
        })
      })
      svg.addEventListener("mouseleave", () => { tip.classList.add("hidden"); cross.setAttribute("visibility", "hidden") })
    })
  }

  // ─── sections ───────────────────────────────────────────────────────────────
  function render() {
    const m = data, p = m.process, h = m.http, db = m.database, ws = m.websocket, w = WINDOW_LABELS[m.window.key]
    $("meta").textContent = "v" + m.version + " · up " + dur(p.uptimeSeconds) + " · updated " + new Date(m.generatedAt).toLocaleTimeString()
    const e = m.errors
    const navCount = $("nav-errors")
    navCount.textContent = fmt(e.serverErrors)
    navCount.className = "count badge " + (e.serverErrors ? "bad" : "neutral")

    $("overview").innerHTML = tiles([
      tile("Status", db.errors.length ? "Degraded" : "Healthy", db.errors.length ? db.errors.length + " DB probe error(s)" : "DB ping " + ms(db.server && db.server.pingMs), db.errors.length ? "warn" : ""),
      tile("Uptime", dur(p.uptimeSeconds), "since " + new Date(p.startedAt).toLocaleString()),
      tile("Requests", fmt(h.totalRequests), w + " · " + fmt(h.inFlight) + " in flight"),
      tile("5xx rate", pct(h.byStatusClass["5xx"], h.totalRequests), fmt(h.byStatusClass["5xx"]) + " server errors, " + w, h.byStatusClass["5xx"] ? "bad" : ""),
      tile("4xx rate", pct(h.byStatusClass["4xx"], h.totalRequests), fmt(h.byStatusClass["4xx"]) + " client errors, " + w),
      tile("Latency p99", ms(h.latencyMs.p99), "p95 " + ms(h.latencyMs.p95) + " · p50 " + ms(h.latencyMs.p50) + ", " + w),
      tile("Memory (RSS)", fmt(p.memory.rssMb, 1) + " MB", "heap " + fmt(p.memory.heapUsedMb, 1) + " / " + fmt(p.memory.heapTotalMb, 1) + " MB"),
      tile("WebSocket", fmt(ws.authenticatedSockets) + " sockets", fmt(ws.connectedUsers) + " users online"),
      tile("DB pool", db.pool.inUse == null ? "—" : fmt(db.pool.inUse) + " / " + fmt(db.pool.limit), fmt(db.pool.queued) + " queued", db.pool.queued ? "warn" : ""),
    ]) + (db.errors.length ? '<p class="warnings">' + db.errors.map(esc).join("<br>") + '</p>' : "")

    renderErrors()
    renderPerformance()
    renderRoutes()
    renderSlow()
    renderUsers()
    renderSystem()
    renderDatabase()
    renderConfig()
  }

  function errorMatches(g) {
    const f = ui.errFilter, s = g.status
    if (f === "5xx" && s < 500) return false
    if (f === "4xx" && (s < 400 || s >= 500)) return false
    if (f === "429" && s !== 429) return false
    if (f === "auth" && s !== 401 && s !== 403) return false
    if (!ui.errSearch) return true
    const hay = [g.message, g.code, g.name, g.route, g.path, g.user, g.reqId, g.details, String(s)]
      .concat((g.routes || []).map((r) => r.route)).join(" ").toLowerCase()
    return hay.includes(ui.errSearch)
  }

  function renderErrors() {
    const e = data.errors, h = data.http, bs = h.byStatus, w = WINDOW_LABELS[data.window.key]
    const sum = (codes) => codes.reduce((t, c) => t + (bs[c] || 0), 0)
    $("error-tiles").innerHTML = tiles([
      tile("Server errors (5xx)", fmt(e.serverErrors), w, e.serverErrors ? "bad" : ""),
      tile("Client errors (4xx)", fmt(e.clientErrors), w),
      tile("Rate limited (429)", fmt(bs["429"] || 0), w, bs["429"] ? "warn" : ""),
      tile("Auth failures", fmt(sum(["401", "403"])), fmt(bs["401"] || 0) + " × 401 · " + fmt(bs["403"] || 0) + " × 403"),
      tile("Not found (404)", fmt(bs["404"] || 0), w),
      tile("Logged errors", fmt(e.log.inWindow), "logger.error calls, " + w, e.log.inWindow ? "warn" : ""),
      tile("Error kinds", fmt(e.groups.length), "distinct status/code/message"),
    ])
    const cut = $("lists-from")
    cut.classList.toggle("hidden", !e.listsFrom)
    cut.textContent = e.listsFrom ? "Only the most recent errors are kept, so the kinds and lists below start at " +
      new Date(e.listsFrom).toLocaleString() + ". The counts above cover the whole window." : ""

    const codes = Object.entries(bs)
    $("status-codes").innerHTML = codes.length
      ? codes.map(([code, n]) => '<span class="item">' + badge(code) + ' ' + fmt(n) + ' <span class="muted">(' + pct(n, h.totalRequests) + ')</span></span>').join("")
      : '<span class="muted small">No requests yet</span>'

    const groups = e.groups.filter(errorMatches)
    $("error-groups").innerHTML = table([
      { label: "Status", get: (g) => badge(g.status) },
      { label: "Code / type", get: (g) => '<code>' + esc(g.code || g.name || "—") + '</code>' },
      { label: "Message", wrap: true, get: (g) => esc(g.message) },
      { label: "Count", num: true, get: (g) => fmt(g.count) },
      { label: "Routes", wrap: true, get: (g) => g.routes.slice(0, 3).map((r) => '<code>' + esc(r.route) + '</code> <span class="muted">×' + fmt(r.count) + '</span>').join("<br>") + (g.routes.length > 3 ? '<br><span class="muted small">+' + (g.routes.length - 3) + ' more</span>' : "") },
      { label: "Last seen", get: (g) => stamp(g.lastSeen) },
      { label: "First seen", get: (g) => stamp(g.firstSeen) },
      { label: "Last request id", get: (g) => '<code class="muted">' + esc(g.lastReqId || "—") + '</code>' },
    ], groups, e.groups.length ? "No errors match the filter" : "No errors in this window.")

    const server = e.recentServer.filter(errorMatches)
    $("recent-server").innerHTML = server.length ? server.map((ev) => {
      const key = "s:" + ev.reqId + ev.at
      return '<details class="event" data-key="' + esc(key) + '"' + (ui.open.has(key) ? " open" : "") + '><summary>' +
        '<span class="muted small">' + esc(time(ev.at)) + '</span>' + badge(ev.status) +
        '<code>' + esc(ev.route) + '</code><span>' + esc(ev.message) + '</span><span class="muted small">' + ms(ev.durationMs) + '</span>' +
        '</summary><div class="body">' + kv([
          ["Time", new Date(ev.at).toLocaleString()], ["Path", ev.method + " " + ev.path],
          ["Error type", ev.name || "—"], ["Code", ev.code || "—"],
          ["User", ev.user || "anonymous"], ["Acting trainer", ev.trainer || "—"],
          ["Client IP", ev.ip || "—"], ["Request id", ev.reqId || "—"], ["Duration", ms(ev.durationMs)],
        ]) + '<pre>' + esc(ev.message + (ev.stack ? "\n\n" + ev.stack : "")) + '</pre></div></details>'
    }).join("") : empty(e.recentServer.length ? "No server errors match the filter" : "No server errors in this window.")

    const client = e.recentClient.filter(errorMatches).slice(0, 100)
    $("recent-client").innerHTML = table([
      { label: "Time", get: (ev) => '<span title="' + esc(new Date(ev.at).toLocaleString()) + '">' + esc(time(ev.at)) + '</span>' },
      { label: "Status", get: (ev) => badge(ev.status) },
      { label: "Code", get: (ev) => '<code>' + esc(ev.code || "—") + '</code>' },
      { label: "Message", wrap: true, get: (ev) => esc(ev.message) + (ev.details ? '<br><code class="muted small">' + esc(ev.details) + '</code>' : "") },
      { label: "Route", get: (ev) => '<code title="' + esc(ev.method + " " + ev.path) + '">' + esc(ev.route) + '</code>' },
      { label: "User", get: (ev) => esc(ev.user || "—") + (ev.trainer ? ' <span class="muted small">via ' + esc(ev.trainer) + '</span>' : "") },
      { label: "IP", get: (ev) => '<code>' + esc(ev.ip || "—") + '</code>' },
      { label: "Request id", get: (ev) => '<code class="muted">' + esc(ev.reqId || "—") + '</code>' },
    ], client, "No client errors match")

    $("log-errors").innerHTML = e.log.recent.length ? e.log.recent.map((l, i) => {
      const key = "l:" + l.at + i
      return '<details class="event" data-key="' + esc(key) + '"' + (ui.open.has(key) ? " open" : "") + '><summary>' +
        '<span class="muted small">' + esc(time(l.at)) + '</span><span class="badge bad">log</span>' +
        '<span>' + esc(l.message.split("\n")[0]) + '</span><span></span><span class="muted small">' + esc(ago(l.at)) + '</span>' +
        '</summary><div class="body"><pre>' + esc(l.message) + '</pre></div></details>'
    }).join("") : empty("Nothing logged at error level in this window.")
  }

  function renderPerformance() {
    const l = data.http.latencyMs, el = data.process.eventLoopDelayMs, hist = data.chart.points, b = data.chart.bucketMinutes
    const w = WINDOW_LABELS[data.window.key]
    const per = b >= 60 && b % 60 === 0 ? (b === 60 ? "hour" : b / 60 + " hours") : b + " minutes"
    $("chart-title").textContent = w[0].toUpperCase() + w.slice(1) +
      (b > 1 ? ", per " + per + " (latency, event loop and gauges: worst or average)" : ", per minute")
    $("latency-tiles").innerHTML = tiles([
      tile("Average", ms(l.avg), w),
      tile("p50", ms(l.p50), "median"),
      tile("p90", ms(l.p90)),
      tile("p95", ms(l.p95)),
      tile("p99", ms(l.p99), "1 in 100 slower", l.p99 > 1000 ? "warn" : ""),
      tile("Max", ms(l.max), "slowest request"),
      tile("Event loop p99", el ? ms(el.p99) : "—", el ? "max " + ms(el.max) : "sampling", el && el.p99 > 100 ? "warn" : ""),
    ])
    const root = $("charts")
    root.innerHTML =
      chart("Requests", hist, "requests", "", "bar") +
      chart("Server errors (5xx)", hist, "serverErrors", "", "bar") +
      chart("Client errors (4xx)", hist, "clientErrors", "", "bar") +
      chart("Rate limited (429)", hist, "rateLimited", "", "bar") +
      chart("Latency p95", hist, "p95Ms", " ms", "line") +
      chart("Latency p99", hist, "p99Ms", " ms", "line") +
      chart("Average latency", hist, "avgMs", " ms", "line") +
      chart("Event loop delay p99", hist, "eventLoopP99Ms", " ms", "line") +
      chart("Process CPU (of one core)", hist, "cpuPercent", "%", "line") +
      chart("Memory (RSS)", hist, "rssMb", " MB", "line") +
      chart("Heap used", hist, "heapUsedMb", " MB", "line") +
      chart("WebSocket sockets", hist, "wsSockets", "", "line")
    wireTooltips(root)
  }

  function renderRoutes() {
    const rows = sortRows(data.http.routes
      .filter((r) => !ui.routeSearch || r.route.toLowerCase().includes(ui.routeSearch)), ui.routeSort)
    $("routes").innerHTML = table([
      { label: "Route", sort: "route", get: (r) => '<code>' + esc(r.route) + '</code>' },
      { label: "Requests", sort: "count", num: true, get: (r) => fmt(r.count) },
      { label: "Error %", sort: "errorRate", num: true, get: (r) => r.errorRate ? fmt(r.errorRate, 2) + "%" : '<span class="muted">0%</span>' },
      { label: "4xx", sort: "clientErrors", num: true, get: (r) => fmt(r.clientErrors) },
      { label: "5xx", sort: "serverErrors", num: true, get: (r) => r.serverErrors ? '<span class="badge bad">' + fmt(r.serverErrors) + '</span>' : "0" },
      { label: "Avg", sort: "avgMs", num: true, get: (r) => ms(r.avgMs) },
      { label: "p50", sort: "p50Ms", num: true, get: (r) => ms(r.p50Ms) },
      { label: "p95", sort: "p95Ms", num: true, get: (r) => ms(r.p95Ms) },
      { label: "p99", sort: "p99Ms", num: true, get: (r) => ms(r.p99Ms) },
      { label: "Max", sort: "maxMs", num: true, get: (r) => ms(r.maxMs) },
      { label: "Statuses", get: (r) => Object.entries(r.byStatus).map(([s, n]) => badge(s) + '<span class="small muted"> ' + fmt(n) + '</span>').join(" ") },
    ], rows, ui.routeSearch ? "No routes match" : "No requests yet", ui.routeSort)
  }

  function renderSlow() {
    const h = data.http
    $("slow").innerHTML = '<p class="meta">Requests that took ' + esc(ms(h.slowThresholdMs)) + ' or longer, ' + esc(WINDOW_LABELS[data.window.key]) + ', newest first.</p>' + table([
      { label: "Time", get: (r) => stamp(r.at) },
      { label: "Duration", num: true, get: (r) => '<strong>' + ms(r.durationMs) + '</strong>' },
      { label: "Status", get: (r) => badge(r.status) },
      { label: "Route", get: (r) => '<code title="' + esc(r.method + " " + r.path) + '">' + esc(r.route) + '</code>' },
      { label: "User", get: (r) => esc(r.user || "—") },
      { label: "Request id", get: (r) => '<code class="muted">' + esc(r.reqId || "—") + '</code>' },
    ], h.slowRequests, "No slow requests in this window.")
  }

  function renderUsers() {
    const app = data.database.app
    if (!app) { $("users").innerHTML = empty("Unavailable. See the database errors above."); return }
    $("users").innerHTML = tiles([
      tile("Users", fmt(app.users.total), fmt(app.users.admins) + " admin · " + fmt(app.users.suspended) + " suspended"),
      tile("New users", fmt(app.users.new7d) + " / 7d", fmt(app.users.new30d) + " in 30 days"),
      tile("Active lifters", fmt(app.activeUsers.week) + " / 7d", fmt(app.activeUsers.day) + " today · " + fmt(app.activeUsers.month) + " / 30d"),
      tile("Online now", fmt(data.websocket.connectedUsers), fmt(data.websocket.authenticatedSockets) + " devices"),
      tile("Workouts", fmt(app.workouts.total), fmt(app.workouts.last24h) + " in 24h · " + fmt(app.workouts.last7d) + " in 7d"),
      tile("In progress", fmt(app.workouts.inProgress), fmt(app.jointSessionsActive) + " joint sessions"),
      tile("Sets ever logged", fmt(app.sets.everLogged), fmt(app.programs) + " programs"),
      tile("Friendships", fmt(app.friendships.accepted), fmt(app.friendships.pending) + " pending"),
      tile("Reports", fmt(app.reports.total), fmt(app.reports.last7d) + " in 7 days", app.reports.last7d ? "warn" : ""),
      tile("Progress photos", fmt(app.photos.count), fmt(app.photos.totalMb, 1) + " MB"),
      tile("Signed-in devices", fmt(app.refreshTokensActive), "active refresh tokens"),
    ])
  }

  function renderSystem() {
    const p = data.process, host = data.host, ws = data.websocket, el = p.eventLoopDelayMs, h = data.http
    $("system").innerHTML = '<h3>Process</h3>' + kv([
      ["Node.js", p.nodeVersion], ["PID", p.pid], ["Platform", p.platform],
      ["CPU time (user / system)", fmt(p.cpuSeconds.user, 1) + " s / " + fmt(p.cpuSeconds.system, 1) + " s"],
      ["Heap used / total", fmt(p.memory.heapUsedMb, 1) + " / " + fmt(p.memory.heapTotalMb, 1) + " MB"],
      ["External / ArrayBuffers", fmt(p.memory.externalMb, 1) + " / " + fmt(p.memory.arrayBuffersMb, 1) + " MB"],
      ["Event loop delay mean / p99 / max", el ? ms(el.mean) + " / " + ms(el.p99) + " / " + ms(el.max) : "—"],
      ["Requests aborted by client", fmt(h.aborted)],
      ["Requests by method", Object.entries(h.byMethod).map(([k, v]) => k + " " + fmt(v)).join(" · ") || "—"],
      ["Photo decode slots in use", data.uploads.decodesInUse + " / " + data.uploads.maxConcurrentDecodes],
    ]) + '<h3>Host</h3>' + kv([
      ["Host", host.hostname], ["OS", host.os], ["CPUs", host.cpus],
      ["Load average (1/5/15m)", host.loadAverage.join(" / ")],
      ["Memory free / total", fmt(host.freeMemMb) + " / " + fmt(host.totalMemMb) + " MB"],
      ["Host uptime", dur(host.uptimeSeconds)],
    ]) + '<h3>WebSocket</h3>' + kv([
      ["Server running", ws.running ? "yes" : "no"],
      ["Connections (incl. pending auth)", fmt(ws.connections) + (ws.maxConnections ? " / " + fmt(ws.maxConnections) : "")],
      ["Authenticated sockets", fmt(ws.authenticatedSockets)],
      ["Users connected", fmt(ws.connectedUsers)],
      ["Distinct client IPs", fmt(ws.distinctIps)],
    ])
  }

  function renderDatabase() {
    const db = data.database, app = db.app
    const s = db.server ? db.server.status : {}
    const bpTotal = s.Innodb_buffer_pool_pages_total, bpFree = s.Innodb_buffer_pool_pages_free
    const mbOf = (b) => b == null ? "—" : fmt(b / 1048576, 1) + " MB"
    $("database").innerHTML = kv([
      ["Server version", db.server ? db.server.version : "—"],
      ["Ping (pool round trip)", ms(db.server && db.server.pingMs)],
      ["MySQL uptime", dur(s.Uptime)],
      ["Pool open / in use / limit", [db.pool.open, db.pool.inUse, db.pool.limit].map((v) => fmt(v)).join(" / ")],
      ["Pool queue (limit)", fmt(db.pool.queued) + " (" + fmt(db.pool.queueLimit) + ")"],
      ["Threads connected / running", fmt(s.Threads_connected) + " / " + fmt(s.Threads_running)],
      ["Max used connections", fmt(s.Max_used_connections)],
      ["Queries since start", fmt(s.Questions)],
      ["SELECT / INSERT / UPDATE / DELETE", [s.Com_select, s.Com_insert, s.Com_update, s.Com_delete].map((v) => fmt(v)).join(" / ")],
      ["Slow queries", fmt(s.Slow_queries)],
      ["Row lock waits (avg ms)", fmt(s.Innodb_row_lock_waits) + " (" + fmt(s.Innodb_row_lock_time_avg) + ")"],
      ["Deadlocks", s.Innodb_deadlocks == null ? "—" : fmt(s.Innodb_deadlocks)],
      ["Temp tables on disk", fmt(s.Created_tmp_disk_tables)],
      ["Aborted connects / clients", fmt(s.Aborted_connects) + " / " + fmt(s.Aborted_clients)],
      ["Traffic in / out", mbOf(s.Bytes_received) + " / " + mbOf(s.Bytes_sent)],
      ["InnoDB buffer pool used", bpTotal ? fmt((1 - bpFree / bpTotal) * 100, 1) + "%" : "—"],
      ["Database size", db.size ? fmt(db.size.totalMb, 2) + " MB" : "—"],
      ["Idempotency keys stored", app ? fmt(app.idempotencyKeys) : "—"],
      ["Snapshot taken", new Date(db.collectedAt).toLocaleTimeString() + " (cached 15s)"],
    ]) + (db.size ? '<h3>Tables</h3><div id="db-tables">' + table([
      { label: "Table", sort: "name", get: (r) => '<code>' + esc(r.name) + '</code>' },
      { label: "Rows (est.)", sort: "rows", num: true, get: (r) => fmt(r.rows) },
      { label: "Data MB", sort: "dataMb", num: true, get: (r) => fmt(r.dataMb, 2) },
      { label: "Index MB", sort: "indexMb", num: true, get: (r) => fmt(r.indexMb, 2) },
    ], sortRows(db.size.tables.slice(), ui.dbSort), "", ui.dbSort) + '</div>' : "")
  }

  function renderConfig() {
    const c = data.config
    $("config").innerHTML = kv([
      ["Environment", c.nodeEnv || "—"],
      ["Local-only features", c.localOnlyFeatures.length ? c.localOnlyFeatures.join(", ") : "none"],
      ["Trust proxy hops", c.trustProxyHops],
      ["mDNS", c.mdnsEnabled ? "on" : "off"],
      ["Server FQDN", c.serverFqdn || "—"],
      ["Bootstrap admin", c.bootstrapAdminSet ? "set" : "first user"],
      ["Metrics page", c.metricsPageEnabled ? "on" : "off"],
      ["Telegram bot alerts", c.botAlertsEnabled ? "on" : "off"],
      ["Health alert limits", (() => {
        const h = c.healthAlerts, lim = (v, unit) => (v ? v + unit : "off")
        return "p95 " + lim(h.p95Ms, "ms") + ", p99 " + lim(h.p99Ms, "ms") + ", 5xx " + lim(h.errorRatePct, "%") +
          " over " + h.windowMinutes + " min, from " + h.minRequests + " requests"
      })()],
      ["Slow request threshold", ms(data.http.slowThresholdMs)],
    ])
  }

  if (token) load().then(schedule)
  else showLogin()
})()
</script>
</body>
</html>
`
