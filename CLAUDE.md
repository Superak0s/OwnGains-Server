# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The optional backend for the OwnGains fitness app (sibling repo `../OwnGains-App`, which runs fully offline without it): a Bun/TypeScript REST + WebSocket API on MySQL for cross-device sync, accounts and real-time social features (friends, joint workouts, live spectating). No ORM: hand-written SQL via `mysql2/promise`. The central public instance, `owngains.superak0s.com` (the app's default), runs `LOCAL_ONLY_FEATURES=tracking,supplements`, so body tracking and supplements are kept on each device. Anyone can self-host instead. Every instance is one small box: no horizontal scaling, no shared cache or queue, no other instances to reach. The central one has open signup from strangers, so treat every change as facing the public internet (`BOOTSTRAP_ADMIN_USERNAME`, photo quotas, rate limits and `TRUST_PROXY_HOPS` all matter there).

## Commands

```bash
bun install
bun run dev              # bun --watch src/server.ts, hot reload dev server
bun run build             # tsc -p tsconfig.build.json (tests excluded) + tsc-alias + scripts/copy-assets.mjs (copies schema.sql, migrations/ and workouts/demo-photos/ into dist/)
bun run start             # bun dist/server.js (run after build)
bun run owngains list|add|remove <username>   # bun src/owngains.ts: list every user, manage admins (docker: `docker exec <container> owngains ...`)
bun run owngains passwd <username> <newpw>   # reset a password, the only recovery path, since a self-hosted instance may have no mail server
bun run owngains reports [limit]             # list user reports filed on this instance
bun run owngains purge-local-only [--yes]    # delete every user's server copy of LOCAL_ONLY_FEATURES data (dry run without --yes)
bun run owngains backup create|list|verify|restore|prune   # src/utils/backup.ts: mysqldump backups in BACKUP_DIR, restore needs --yes
bun run smoke [url] [--min-version x.y.z]   # scripts/smoke.mjs: live HTTP+WS smoke test against a running server, creates and deletes a throwaway account
bun run sonar:scan       # scripts/sonar-scan.sh: SonarQube analysis (config in sonar-project.properties)
```

`bun run test` (vitest, add `--coverage` for a report) needs a live MariaDB 11.4, the version CI and the official server run: `src/tests/global-setup.ts` rebuilds `<DB_NAME>_test` (or `TEST_DB_NAME`) from `.env` credentials, and route tests drive the real `app` through supertest. Tests are kept in `__tests__/` next to the code they cover (`src/__tests__/` for server-wide ones), with shared helpers (`signup`, `auth`, `internalId`, `runCli`) in `src/tests/helpers.ts`. Run one file with `bunx vitest run <path>`. There is no linter, so don't invent `bun run lint`.

Needs a `.env`, which Bun loads on its own (no `dotenv`). `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET` (≥32 chars) and `ALLOWED_ORIGINS` are required or boot throws. README has every other variable. The DB and schema auto-provision on a fresh database. Everything runs on Bun, never Node (`bunfig.toml` `[run] bun = true` reroutes shims that call `node`), so write new scripts as `bun <file>`.

## Architecture

**Request pipeline** (`src/server.ts`): `helmet` (CSP `default-src 'none'`, pure JSON API) → `cors` (`ALLOWED_ORIGINS`) → `compression` → request id + logger → rate limiters → `express.json` (50kb, with a 2mb parser for `/api/program/upload` and `/api/sharing/permissions` mounted first, behind `authenticateToken`) → `GET /healthz` → routes → 404 → `errorHandler`. Limits and their env knobs are in README.

- Body parsing sits _after_ the rate limiters, and the 2mb parser behind auth, so an anonymous caller can't buy `JSON.parse` CPU on a one-core box.
- `TRUST_PROXY_HOPS` must be `1` behind a TLS-terminating proxy (or every client shares one rate-limit bucket) and `0` when the port is exposed directly (or a client can spoof `X-Forwarded-For` to reset its limiter).
- HTTP and WS share one `http.createServer`. mDNS advertises `_owngains._tcp` unless `MDNS_ENABLED=false`, which public hosts should set. `getLanInterface()` picks a physical NIC because multicast-dns otherwise binds to a Docker/WSL/VPN adapter.
- `shutdown()` handles `SIGTERM`/`SIGINT`/uncaught exceptions. It is idempotent, `/healthz` answers 503 while draining, and it awaits an in-flight session sweep before `pool.end()`. Tear down any new long-lived resource there. Unhandled rejections are logged, not fatal.
- Pool overload and query timeouts return 503 + `Retry-After`, not 500.

**Skin marketplace** (`src/marketplace/`): a second entry point (`server.ts`, `cli.ts`) with its own image (`Dockerfile.marketplace`), compose profile and database (`schema.sql`, re-run on every boot, no migrations yet). It shares `config/database.ts`, `errorHandler` and validation helpers with the server but no routes or tables. Auth is the caller's bearer token checked against `AUTH_SERVER_URL/api/auth/me` (`auth.ts`). Tests run against the same test database, and `global-setup.ts` creates its tables.

**Feature-first layout**: each domain is `src/features/<domain>/` with a same-named trio: `<name>.routes.ts` (router, validation), `<name>.model.ts` (SQL via `pool.execute<RowDataPacket[]>` / `pool.execute<ResultSetHeader>`) and often `<name>.types.ts`.

- Nested domains: `tracking/<metric>/` (`bodyStats` and `hydration` are thin routers over `measurements`, which stores every scalar metric) and `social/{friends,sharing}/`. The rest are flat.
- `workouts/` is mounted at `/api/sessions`, not `/api/workouts`. Its `demo.model.ts` and `demo-photos/` are demo data the build copies into `dist/`.
- `messages` and `push` are served only while FCM push works (`FCM_SERVICE_ACCOUNT`), otherwise 410 `FEATURE_DISABLED`, like anything in `DISABLED_FEATURES`.
- `trainer/trackingRelay` is the end-to-end encrypted tracking relay at `/api/sharing/tracking`, mounted ahead of `/api/sharing`.
- `legal/` serves the official policy pages from GitHub when `LEGAL_PAGES_ENABLED=true`, with its own CSP.
- Every router is mounted in `registerRoutes()` (`src/routes.ts`). `/api/version` is an inline `app.get` there, so route-scanning tools miss it. Features in `LOCAL_ONLY_FEATURES` (`tracking`, `supplements`) are never mounted (410 `FEATURE_LOCAL_ONLY`), and the list is echoed on `/healthz` so the app logs them on-device. Dropping a feature from the server is a config change, not a client release.
- Writes outside `/api/auth` need recorded Terms acceptance (`authenticateToken`, `REQUIRE_TERMS_ACCEPTANCE`). Health-data writes (workouts, programs, tracking, sharing, trainer) also pass `healthConsentGuard` (`features/tracking/healthConsent.ts`, `REQUIRE_HEALTH_CONSENT`), which answers 403 until the owner has recorded GDPR Art. 9 consent. Reads and deletes pass. A new health-data router needs it too.

**Auth** (`src/middleware/auth.ts`): HS256 JWT carrying `users.uuid` plus a `tokenVersion` checked on every request, so bumping `users.token_version` revokes all of a user's tokens. `users.uuid` is the only user identity that leaves the server (responses, route params, `X-Trainee-Id`, WS events). Numeric `users.id` is for joins only. Hash passwords through `features/auth/password.ts`, which caps concurrent hashes, never bcrypt directly. Failed password checks are throttled per account (`auth_throttle`). `users.disabled_at` suspends an account for HTTP and WS alike. The first user becomes admin unless `BOOTSTRAP_ADMIN_USERNAME` names one. `requireAdmin` guards `/api/admin`, and the `owngains` CLI manages admins and suspensions.

**Metrics** (`src/features/metrics/`, gated by `METRICS_ENABLED` / `METRICS_PAGE_ENABLED`): in-process counters from `metricsMiddleware`, served admin-only at `GET /api/admin/metrics`. `/admin/metrics` is a static dashboard and the one response that relaxes helmet's CSP (per-response nonce). Errors are captured from `res.locals.error` (set by `errorHandler`, so production masking doesn't hide them), any other >= 400 JSON body, and every `logger.error`.

**Trainer mode** (`src/middleware/trainerContext.ts`): with an `X-Trainee-Id` header and an active `trainer` permission, `applyTrainerContext` swaps `req.user` to the trainee and keeps the actor on `req.trainer`. It is mounted on the sessions, program, analytics and schedule routers only (never messages: a message is always sent as its author), and `/api/auth` never sees it. The grant is additive: every destructive route on those routers must also use `denyTrainer`. A new route there isn't finished until you've decided which side of that line it's on.

**Idempotency** (`src/middleware/idempotency.ts`): `idempotent` routes take an optional `Idempotency-Key`, which the app sends when replaying offline-queued writes. A replay gets the stored response (48h, `idempotency_keys`), a concurrent retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT`, a non-2xx releases the key, and keys are scoped by `actor_id` so a trainer and trainee never share one. Any new write the app queues offline needs it. Session start/set/end, the tracking inserts, messages and schedule writes already use it.

**Validation**: `src/middleware/validation.ts` exports the shared primitives (`parseIntParam`, `queryLimit`, `validateRequired`, per-domain body validators). They throw `ValidationError` synchronously and Express 5 forwards thrown errors, so no `try`/`catch` + `next(err)` wrapper. Don't hand-roll id parsing or limit clamping.

**Errors**: throw the typed classes from `src/middleware/errorHandler.ts` (`UnauthorizedError` and friends) rather than crafting raw error responses. `NODE_ENV=production` masks internal details.

**WebSockets** (`ws/wsServer.ts`, `/ws`): the JWT arrives in an `auth` message over the socket, never in the handshake URL, where access logs would record it. Connection caps are enforced in `verifyClient`, alongside per-user message rate, size and socket limits (`WS_MAX_SOCKETS_PER_USER`, oldest evicted). The 30s heartbeat revalidates tokens in batched `IN (?)` queries. Rate counters are in-process, so **the server is single-instance only**.

**Background jobs**: `jobs/sessionCleanup.ts` ends workouts idle >30min (on boot, then every 5min) and purges expired idempotency keys. Runs never overlap (`stopStaleSessionCleanup()` returns the in-flight one for shutdown to await), and `GET_LOCK` keeps two processes from sweeping at once. Each ended workout pushes `session_auto_ended` to its owner, so the app doesn't find out through a 404 that eats the set just logged.

**Database**: `src/config/schema.sql` is all `CREATE TABLE IF NOT EXISTS` and re-runs on every boot, so a new table goes straight in there. A change to an _existing_ table goes in a new `src/migrations/NNN_description.sql`, applied once per database by `runMigrations()` (tracked in `_migrations`, under `GET_LOCK`). A fresh database stamps every migration as applied _without running it_, so mirror each one into `schema.sql` too, or new installs and the test DB never get it. Note every new file in `src/migrations/README.md`. 0.6.0 is the baseline: no migration files exist yet, and a database from before 0.6.0 must be re-created.

**Uploads**: photos only, `multer` memory storage into `LONGBLOB`s (10MB, image-only, magic-byte checked), re-encoded by `sharp` to a metadata-free JPEG of at most 2048px plus a 400px thumbnail. Decodes are bounded (header pixel cap, `sharp.concurrency(1)`, two decode slots, 503 when full). Per-user quota is checked inside the insert transaction, and `PHOTO_TOTAL_QUOTA_GB` caps the instance (507). Program spreadsheets are parsed in the app: the server validates the JSON (`validateProgramUpload`, before the transaction opens) and unpacks it into `programs`/`program_days`/`program_exercises`.

**Imports**: ESM with NodeNext resolution, so local imports need explicit `.js` extensions, aliased ones included. `@/*` maps to `src/` (`tsconfig.json` `paths`, no `baseUrl`). Use `@/` for anything two or more levels up and a relative `../` for a sibling. `tsc` doesn't rewrite `paths` on emit, so `bun run build` runs `tsc-alias` after it. Any new build or entry point must keep that step. `package.json` remains at the root, read at runtime by `config/version.ts`.

## Releasing

`scripts/release.sh` (Git Bash on Windows) bumps the version, commits & pushes to `origin main`, then builds and pushes `superak0s/owngains-server:latest` and `:<version>` to Docker Hub. This is a real deploy action. Don't run it without being asked to release. A `PreToolUse` hook enforces this: any Bash command mentioning `release.sh` is denied outright, so the release is run by hand.

On a version bump, `scripts/changelog.mjs` (`check` / `stamp` / `notes`, runnable directly) renames `[Unreleased]` to `## [x.y.z] - <date>` before the build, leaves it alone when empty, and stops the run when malformed. A failed build restores `CHANGELOG.md` from a pre-rename copy, not git, because `[Unreleased]` entries are usually uncommitted. That version's section becomes the GitHub release notes.

## Changelog

Every change you make to the repo gets an entry in `CHANGELOG.md` under `## [Unreleased]`, in the same turn as the change, not batched up for later, and not left for the user to write. The file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

- Changes someone running the server or building the app against it can notice go under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security` (auth, rate-limit, upload, privacy or permission changes go in `Security`). Write them for that reader: what an operator or API client can now do or what behaves differently (new routes, response shapes, status codes, env variables), not which file or function changed.
- Everything else (refactors, tests, tooling, build scripts, dependency bumps, docs, `.claude/` config, migrations that only add indexes) goes under `### Internal`, one short line each.
- One bullet per change. If a later edit in the same session revises something already listed under Unreleased, update that bullet instead of adding another.
- Create any missing heading inside `[Unreleased]`, keeping the order above with `Internal` last. Never edit a released version's section, and never add a version heading yourself. Entries always go under `[Unreleased]` whatever `package.json` says, and `scripts/release.sh` renames it when the version is bumped.
- A change that is purely reverted in the same session leaves no entry.

Conflicts in `CHANGELOG.md` `[Unreleased]` are expected when branches overlap. Resolve them by keeping both sets of bullets. Never rewrite history that has already been pushed.

## Markdown files

`*.md` is gitignored by default. Only `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `src/migrations/README.md`, `.claude/**` and `.github/**` are allowed back. Working notes (audits, fix lists, plans) written as `.md` elsewhere remain local. A new doc that belongs in the repo needs a `!` line in `.gitignore`.

## Prose Style

Applies to Markdown, `CHANGELOG.md` entries, code comments, and the error, log and UI strings in `.ts` files. It does not apply to code itself:

- No em or en dashes. Use a period, comma, colon or parentheses instead, and "to" for a range.
- No semicolons. Split into two sentences or restructure.
- Skip stock filler: "notable", "genuinely", "a single" (say "one"), and "for example", "therefore" or "conversely" as connectors.
- Use literal verbs, not figurative ones: a file is stored in a folder (it doesn't live there), a commit is merged into `main` (it doesn't land), a release includes a change (it doesn't ship it), and data is kept or remains (it doesn't survive or stay).

## Claude Code tooling

- **Typecheck hook**: a `PostToolUse` hook runs `bunx tsc --noEmit` after every `Edit`/`Write` to a `.ts` file and blocks the edit if it fails, which catches a missing `.js` extension or an unresolved `@/` alias.
- **README hook**: a second `PostToolUse` hook (`.claude/hooks/readme-reminder.mjs`) adds a reminder to check README.md after an edit to a feature's `.routes.ts`/`.model.ts`, `src/routes.ts`, `config/env.ts`, `schema.sql`, `ws/wsServer.ts` or `jobs/`. It never blocks.
- **Protect-files hook**: a `PreToolUse` hook (`.claude/hooks/protect-files.mjs`) denies edits to `.env` and to any migration already committed to git. Edit `.env.example` or add a new migration instead.
- **`/readme-audit`**: user-invoked skill that compares every README section with the code (routes, env variables, tables, WS events, jobs, CLI) and fixes the drift.
- **`/new-feature`**: user-invoked skill that walks the feature trio (`<name>.{routes,model}.ts`), the `registerRoutes` mount, the schema-vs-migration decision, and the test file. It does not self-invoke.
- **`security-reviewer`** and **`sql-reviewer`** subagents: launched on request, not automatically. The first audits auth, WebSocket, rate-limit/proxy-trust and upload paths. The second checks placeholder discipline in `pool.execute` calls and whether a schema change belongs in `schema.sql` or a new migration.
- **MCP servers** (local scope, this project only): `context7` for live docs on the recent majors here (Express 5, helmet 8, multer 2), and `mysql-test`, a read-only connection to `owngains_test`, useful because there is no ORM and so no generated types to read the live schema from.
