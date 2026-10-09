# OwnGains Server

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/superak0s)

The optional backend for the [OwnGains](../OwnGains-App) fitness app. It provides cross-device sync, user accounts, and real-time social features (friends, joint workouts, live spectating).

> **The OwnGains app does not require this server**. It runs fully offline out of the box. Run this only if you want to sync across devices or enable social/live features, either via the central instance at `https://owngains.superak0s.com` or your own self-hosted one.

A Bun / TypeScript REST + WebSocket API, backed by MySQL, Docker-first and self-hostable. Every deployment is one box, with no horizontal scaling and no instances talking to each other.

**Central instance:** `https://owngains.superak0s.com` is the public server the app points at by default. It runs with `LOCAL_ONLY_FEATURES=tracking,supplements`, so body tracking (weight, measurements, hydration, soreness, cycle, injuries, notes, macros, progress photos) and supplements are never stored there. The app keeps them on the device. Workouts, programs, settings, accounts and social features sync through it. Self-host your own instance if you want those features synced too, or all your data under your control.

---

## Tech stack

- **Runtime:** Bun (Docker image `oven/bun:1-alpine`), **TypeScript 7**, compiled with `tsc` (+ `tsc-alias` for the `@/*` path alias), run via `bun --watch` in dev. `bunfig.toml` sets `[run] bun = true`, so every script and tool shim that calls `node` runs on Bun as well.
- **Framework:** **Express 5**.
- **Database:** **MySQL** via `mysql2` (`mysql2/promise` connection pool). No ORM: hand-written SQL with an idempotent `schema.sql` plus numbered migrations.
- **Auth:** **JWT** access tokens (`jsonwebtoken`, HS256) + opaque rotating refresh tokens, native **bcrypt** (12 salt rounds, run on the libuv threadpool behind a concurrency cap) for password hashing.
- **Real-time:** **WebSockets** (`ws`).
- **Uploads:** **multer** (memory storage for photos, magic-byte checked, stored as LONGBLOB) + **sharp** (re-encodes each photo to a metadata-free JPEG of at most 2048px and bakes a 400px thumbnail).
- **Security:** `helmet`, `cors`, `express-rate-limit`.
- **Compression:** `compression`: gzip on JSON responses over 1 kb (already-compressed types like photo BLOBs are skipped).
- **Discovery:** `bonjour-service`: the server advertises itself on the LAN as `_owngains._tcp`.
- **Tests:** **vitest** + `supertest` against a real MySQL (`bun run test`).
- **Package manager:** **Bun**.

---

## Architecture

Request pipeline (`src/server.ts`): `helmet` (CSP `default-src 'none'`, pure JSON API) → `cors` (locked to `ALLOWED_ORIGINS`) → `compression` (gzip, 1 kb threshold) → per-request UUID + logger → rate limiters → `express.json` (50 kb, while `/api/program/upload` and `/api/sharing/permissions` get a 2 MB parser mounted first, behind `authenticateToken`) → `GET /healthz` → routes → 404 → global error handler. Body parsing sits _after_ the rate limiters, and the 2 MB parser behind auth, so a flood is rejected before the server pays to buffer and parse the payload.

- **Fails fast** on boot if `DB_USER`/`DB_PASSWORD`/`DB_NAME` are missing, `JWT_SECRET` is missing/`<32` chars, `ALLOWED_ORIGINS` is unset or contains `*`, `TRUST_PROXY_HOPS` is not a non-negative integer, `LOCAL_ONLY_FEATURES` names an unknown feature, or any numeric/boolean variable read through the shared parser is malformed (a few, such as `DB_PORT` and `RATE_LIMIT_BYPASS_LOCAL_IPS`, only accept the exact value and otherwise fall back). Booleans accept `true/false/1/0/yes/no/on/off`, case-insensitive.
- **Rate limits (per IP):** failed `signin` / `password` / `DELETE account` / `DELETE account/data` attempts = 20 / 15 min, `signup` = 20 / 15 min, and all of `/api` = 200 req / 60 s. Bodies over 50 kB on the 2 MB routes = 20 / 15 min per user. Photo uploads = 60 / 15 min per account (not tunable). All limiters are skipped under vitest.
- **Feature-first layout:** code is in `src/features/<domain>/<name>.{routes,model,types}.ts`, and every router is mounted in `src/routes.ts`.
- `GET /healthz` is unauthenticated, outside the `/api` limiters, and reports `{ status, fqdn, localOnlyFeatures }`, or `503 DOWN` if a cached (5 s) `SELECT 1` against MySQL fails.
- On startup: tests the DB connection, auto-provisions the database + schema and runs pending migrations, starts the WebSocket server and the stale-session cleanup job, advertises over mDNS, and listens on `PORT` (default 5000). Graceful shutdown on SIGTERM/SIGINT/uncaught exception (`/healthz` answers 503 while draining). An unhandled promise rejection is logged with its stack and the process keeps running.

---

## API

All routes are under `/api` and require a JWT `Authorization: Bearer <token>` unless noted. Unauthenticated: `POST /api/auth/{signup,signin,refresh}`, `GET /healthz`, the `/admin/metrics` page and the legal `*.html` pages.

Access rules: writes (anything but `GET`/`HEAD`/`DELETE`) outside `/api/auth` need recorded Terms acceptance (`403 TERMS_NOT_ACCEPTED`). Writes on tracking, sessions, program and sharing also need recorded health consent (`403 HEALTH_CONSENT_REQUIRED`). See `REQUIRE_TERMS_ACCEPTANCE` / `REQUIRE_HEALTH_CONSENT`. A suspended user's sign-in answers `403 ACCOUNT_DISABLED`.

### Auth (`/api/auth`)

| Method | Path              | Purpose                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/signup`         | Register (first-ever user, or `BOOTSTRAP_ADMIN_USERNAME`, becomes admin), returns tokens                                                                                                                                                                                                                              |
| POST   | `/signin`         | Login by username or email, returns access + refresh token                                                                                                                                                                                                                                                            |
| GET    | `/me`             | Current user. Every user object here includes `heightCm` and `bfFormulaSex` (`null` until set)                                                                                                                                                                                                                        |
| PUT    | `/profile`        | Update profile (name, email, height/units, body-fat formula sex `male`/`female`). Changing `email` needs `currentPassword` (400 `CURRENT_PASSWORD_REQUIRED`, 403 if wrong). Height and sex are ignored while `tracking` is in `LOCAL_ONLY_FEATURES`                                                                   |
| PUT    | `/consent`        | Record `termsVersion` (accepted now) and/or `healthConsent` (`true` grants, `false` withdraws and deletes the user’s stored tracking and supplement data, height and body-fat sex). Signup takes the same two fields, and user objects return `termsVersion`, `termsAcceptedAt`, `healthConsentAt`                    |
| PUT    | `/password`       | Change password (`currentPassword`, `newPassword`) and return `{ token, refreshToken }` for the caller. Bumps `token_version`, signing out every other device                                                                                                                                                         |
| DELETE | `/account/data`   | Wipe all user data (body `confirmDelete: "DELETE_ALL_DATA"` and the current `password`, 400 `PASSWORD_REQUIRED` without it, 403 if wrong). Keeps the account. Reports the user filed are kept, anonymised                                                                                                             |
| DELETE | `/account`        | Delete the account and all its data (re-checks password: a wrong one is 403, not 401, and counts toward the per-account throttle)                                                                                                                                                                                     |
| GET    | `/account/export` | Everything held about the caller as JSON (photo bytes omitted). `truncatedTables` lists any table that hit the 50,000-row cap                                                                                                                                                                                         |
| POST   | `/refresh`        | **Unauthenticated.** Spend a refresh token for a new access token + a rotated refresh token. Reuse of a spent token kills the whole token family (`REFRESH_REUSED`). Without a `refreshToken` it answers 401 `REFRESH_TOKEN_REQUIRED` |
| POST   | `/signout`        | Revoke the presented refresh token (`204`, even if unknown). With `allDevices: true` it revokes every refresh token, bumps `token_version` and answers `200 { token, refreshToken }` so this device remains signed in                                                                                                 |

### Workout sessions (`/api/sessions`)

`GET /` (history with `?split=`, `?dayNumber=`, `?limit=` default 30 max 365, `?includeTimings=true`, `?before=<nextCursor>`, returns `{ sessions, nextCursor }`) · `GET /exercise-records` (every session containing an all-time record set, trimmed to those sets) · `POST /start` · `POST /:sessionId/set` (record a set and push live WS updates) · `PATCH /:sessionId/sets/:setId` (edit a set) · `PATCH /:sessionId` (move a running workout to another program day, body `dayNumber`, optional `dayTitle`) · `POST /:sessionId/end` (a no-op returning `alreadyEnded: true` on an ended workout) · `GET /:sessionId` · `POST /rename-exercise` (bulk rename across a split's history) · `DELETE /demo` · `DELETE /split/:split` · `DELETE /:sessionId/sets` (query `?exerciseName=&setIndex=`, 0-based). The deletes return `{ deletedCount }`.

`POST /start`, `/:sessionId/set`, `/:sessionId/end` and `PATCH /:sessionId` accept an optional `Idempotency-Key` header (1 to 64 chars, scoped per user and, in trainer mode, per acting trainer, see `src/middleware/idempotency.ts`). A repeat with the same route and body within 48h gets the stored 2xx response back without writing again, a different route or body answers `422 IDEMPOTENCY_KEY_REUSED`, and a retry while the first request is still running answers `409 IDEMPOTENCY_KEY_IN_FLIGHT`. A non-2xx response releases the key. The offline-style tracking writes take the same header: `POST /api/tracking/hydration`, `/measurements`, `/macros/log`, `/supplements/:id/log`, `/soreness` and both follow-up routes, `/injuries`, `/personal-notes` and `/menstrual`. Photo upload does not, because the key is checked before the multipart body is parsed. A 403 for a session the caller doesn't own (or that's gone) includes `code: "SESSION_NOT_FOUND"`.

### Program (`/api/program`)

`GET /` (includes `currentDay`, `404` when the user has no program) · `POST /upload` (`{ weeklyPlan, originalFilename }`, persist client-parsed program JSON, 2 MB cap) · `DELETE /` · `GET`/`PUT /current-day` (`{ currentDay: null }` when no program, and the day must exist) · `PATCH /exercise/{rename,add,sets,machine}`. Program spreadsheets are parsed **client-side**. The server only validates the JSON and unpacks it into `programs`/`program_days`/`program_exercises`, rebuilding the same shape on read.

### Admin (`/api/admin`)

Admin-only (`401`/`403` otherwise). `GET /reports` (`?limit=`, default 100, max 500) lists user reports. `POST /users/:userId/suspend` (body `{ "reason": "…" }`, required, at most 500 characters, shown to the user in the sign-in error) and `/unsuspend` (`:userId` is the user's uuid) suspend or restore an account. A suspended user is signed out everywhere and can't sign in, refresh or open a WebSocket. Nothing is deleted. Admins can't be suspended here (demote them with the CLI first). Metrics routes are under [Metrics](#metrics).

### Analytics / Version

`GET /api/analytics`: totals for the caller: session count, sets completed, volume, first/last session. Filters: `?split=`, `?dayNumber=`, `?days=` (default 365, max 3650).
`GET /api/version`: the running version, **authenticated**, since an exact version is a targeting aid.
An unauthenticated `GET /healthz` liveness probe is served outside `/api`.

### Trainer mode

Send `X-Trainee-Id: <trainee uuid>` with an active `trainer` sharing grant and `req.user` is swapped to the trainee for that request, and the actor is kept aside for WS events. Mounted on the **sessions, program and analytics** routers only. `/api/auth` never sees it, so a trainer can't touch a trainee's account. What a trainer may do is additive: recording and editing sets, starting and ending workouts, `PATCH /exercise/{add,sets,machine}` and `PUT /current-day`. Every destructive route (all deletes, `POST /program/upload`, `POST /sessions/rename-exercise`, `PATCH /program/exercise/rename`) is guarded by `denyTrainer` and answers 403. Handler-level limits: editing a set only works on a workout in progress (`TRAINER_WORKOUT_ENDED`), and `PATCH /program/exercise/sets` with a negative `additionalSets` or `/machine` with any `null` in the patch is refused (`TRAINER_DESTRUCTIVE_EDIT`). A bad or unauthorised `X-Trainee-Id` answers `403 NOT_A_TRAINER`. Writes made as a trainer are audit-logged.

### Tracking (`/api/tracking/*`)

Every tracking router requires auth. Writes also need recorded health consent (`PUT /api/auth/consent`) unless `REQUIRE_HEALTH_CONSENT=false`. Reads and deletes remain open so a user who withdrew consent can still see and erase their data.

- **`bodystats`**: weight log (`POST`/`GET /weight`, `GET /weight/current`, `DELETE /weight/:id`) and body fat (`POST`/`GET /bodyfat/log`, `DELETE /bodyfat/log/:id`) with the US-Navy calculation.
- **`measurements`**: every scalar metric, built-in or user-defined: `POST /` (a map of metric → value), `GET /?metrics=a,b`, `GET /:metric/history` (one metric as a chart series), `GET`/`POST /definitions`, `DELETE /:id` (`?metrics=a,b` deletes the whole measuring session). `bodystats` and `hydration` are thin routers over it.
- **`hydration`**: `POST /` (accepts `Idempotency-Key`), `GET /`, `DELETE /:id`.
- **`soreness`**: `POST`/`GET /` (`?muscle=` and `?status=active` filter the list), `GET /active`, `GET /stats`, `GET /muscle/:muscle` (the last two are the list with one filter fixed), `POST /follow-ups` (check in on many episodes at once), `POST /:id/follow-ups` (deprecated: use the batch route), `DELETE /:id`.
- **`menstrual`**: `POST`/`GET /`, `GET /stats`, `PATCH`/`DELETE /:id`.
- **`injuries`**: `POST`/`GET /` (`?muscle=` and `?status=active` filter the list), `GET /active`, `GET /muscle/:muscle` (the list with one filter fixed), `PATCH`/`DELETE /:id`.
- **`personal-notes`**: `POST /`, `GET /muscle/:muscleGroup`, `DELETE /:id`.
- **`macros`**: `POST`/`GET /log`, `DELETE /log/:id`. Goals are stored in `/api/settings`, and summaries are computed client-side.
- **`supplements`**: `GET`/`POST /`, `PATCH`/`DELETE /:id`, intake via `POST /:id/log`, `GET /:id/log`, `DELETE /:id/log/:entryId`. Can be made local-only separately from the rest of tracking (see `LOCAL_ONLY_FEATURES`).
- **`photos/muscle`**: upload, `GET /`, `GET /group/:muscle`, `GET /:id/image` (raw bytes), `GET /:id/thumb` (400px JPEG, built at upload with `sharp`, lazily for older photos), `DELETE /:id`. Stored as LONGBLOB with muscle-group tags and a front/back/side/custom angle. The upload:
  - takes multipart field `photo`, plus a `muscleGroups` JSON array of at least one, `angle`, `customSideName`, `takenAt` and `note`, and returns `201 { id, uri, thumbUri }`
  - allows 60 uploads / 15 min per account (`429` past that)
  - uses multer memory storage: image only, 10 MB, magic-byte checked, 40 MP cap, re-encoded to a metadata-free JPEG of at most 2048px
  - answers `400 PHOTO_QUOTA_EXCEEDED` over the per-user quota, `507` over the instance quota, and `503` when both decode slots are busy

### Settings (`/api/settings`)

`GET /` and `PATCH /` read and update every user preference in one row: `hydrationGoalMl`, `hydrationErrorPercent`, `cyclePeriodDays`, `cycleLengthDays`, `macroProteinGoal`, `macroCarbsGoal`, `macroFatGoal`, `macroCaloriesGoal` (numbers ≥ 0, and the first, third and fourth must be integers). Unknown keys or an empty patch are 400, `null` values are skipped. Both routes return `{ success, data }` with `updatedAt`. Ranges are `CHECK` constraints in the schema, and a violation comes back as a 400. Part of the `tracking` group (cycle length is menstrual data): needs health consent for writes, answers `410 FEATURE_LOCAL_ONLY` when `tracking` is local-only, and is erased on consent withdrawal.

### Social (`/api/friends` & `/api/sharing`)

- **Friends:** `GET /search` (`?q=` username prefix, ≥3 characters, `?limit=` default 10, max 20), `GET /` (`?include=requests` adds `pendingRequests` and `sentRequests`), `GET /requests/{pending,sent}`, `POST /request`, `POST /request/:friendshipId/{accept,reject}`, `DELETE /:friendId`. A declined request can't be re-sent to the same person for 30 days (1 hour if the sender cancelled it).
- **Blocking:** `POST`/`DELETE /block/:userId` and `GET /blocked`. A block tears down the friendship, every sharing permission in both directions, and any outstanding joint invite, then hides each user from the other's search and blocks new requests.
- **Reporting:** `POST /report` (`userId`, `reason`, optional `details`). Reports are stored on the instance for its operator to review with `bun run owngains reports` or `GET /api/admin/reports`. Nothing is forwarded to another server.
- **Sharing permissions:** `POST /permissions` (grant), `GET /permissions/{granted,received}`, `GET /permissions/:permissionId/payload`, `DELETE /permissions/:permissionId`. Types: `history`, `analytics`, `program`, `joint_session`, `watch_session`, `trainer`. Grants need `{ friendId (uuid), permissionType, payload? }` and a friendship (403 otherwise). A `program` grant needs `payload.programData`, capped at 256 KB (`413 PAYLOAD_TOO_LARGE`). The `granted`/`received` lists omit payloads unless `?includePayload=true`.
- **Shared reads:** `GET /sessions/friend/:friendId` (`?includeTimings=true` adds each session's `setTimings`, and it pages with `?before=<nextCursor>` like `GET /api/sessions`) and `/sessions/friend/:friendId/:sessionId`. Sets are listed in the order they were performed.
- **Joint sessions:** `GET /joint-sessions/friend/:friendId/status` (deprecated: use the batch route), `GET /joint-sessions/status?friendIds=<uuid>,…` (up to 100 friends at once, non-friends omitted, and a friend reads as idle unless they granted the caller `watch_session`, `joint_session` or `trainer`), `POST /joint-sessions/invite` (the invitee must have granted the caller `joint_session`, 403 otherwise), `POST /joint-sessions/invites/:inviteId/{accept,decline}`, `PATCH /joint-sessions/:id/progress`, `DELETE /joint-sessions/:id/leave`, for two friends working out in sync. Leaving (here or with the WS `leave_joint_session` frame) sends the partner both `joint_session_ended` and `invite_status { status: "session_ended" }`.
- **Watch sessions:** `GET /watch/friend/:friendId/active` and `GET /watch/friend/:friendId/session/:sessionId/live` to spectate a friend's live workout. Both need friendship plus a `watch_session` grant (403 otherwise). Polling `/live` is what registers the watch: the first poll sends the owner `watch_started`, and 60 s of silence sends `watch_stopped`. Watch state is in-process memory.

---

## WebSockets (`/ws`)

Mounted on the same HTTP server. Auth via a JWT `auth` message sent over the socket after connecting, never in the handshake URL, where a long-lived token would be captured by server and proxy access logs. Hardened with a 2 s auth timeout, per-IP and global connection caps, per-user 20 msg/sec rate limit (exceeding it closes the socket), 8 KB max message size, and a 30 s heartbeat ping that also re-checks every signed-in user's token version in one batched query. A user may have up to 5 sockets (devices) at once, and events are sent to all of them. See the `WS_*` variables below.

**Server → client events:** `auth_success`, `auth.refreshed`, `error`, `joint_invite`, `invite_status`, `joint_progress`, `joint_session_ended`, `friend_request_received`, `live_set_recorded`, `watch_started`, `watch_stopped`, `trainer_set_recorded`, `trainee_set_recorded`, `friend_session_started`, `friend_session_ended`, `watch_progress`, `trainer_session_started`, `trainer_session_ended`, `session_auto_ended`.
**Close codes:** `4001` unauthorized / expired / revoked token, `4002` server error during auth, `4008` rate limit exceeded, `1000` evicted by a newer socket, `1001` server shutting down. Upgrades are refused with `503` over `WS_MAX_CONNECTIONS` and `429` over `WS_MAX_CONNECTIONS_PER_IP`. Frames that aren't an object with a string `type` are ignored.
**Client → server:** `auth`, `auth.refresh` (hand a refreshed access token for the same user to an open socket, so the heartbeat stops closing it at the old token's expiry), `push_joint_progress`, `leave_joint_session`.

> The WS rate counters are in-process memory, so the server is designed for **one instance**. Horizontal scaling would require a shared store (e.g. Redis).

---

## Background jobs

`startStaleSessionCleanup()` (`jobs/sessionCleanup.ts`) auto-ends workout sessions inactive for >30 min. Runs on boot then every 5 min, as a server-side backstop to the client's own inactivity timer. Each ended workout gets a `session_auto_ended` WS event pushed to its owner, so the app doesn't discover it as a 404. Runs never overlap, and `GET_LOCK` keeps two processes sharing a database from sweeping at once. Each batch of 500 is locked and ended in one transaction. The same sweep (same cadence) also purges: expired idempotency keys (48h), expired refresh tokens, stale joint sessions, expired friend-request cooldowns, user reports older than `REPORT_RETENTION_DAYS`, stale sign-in throttle rows, accounts that never recorded consent (30 days), and accounts restored from a backup that were erased after it was taken (`deleted_accounts` tombstones). Each purge is isolated, so one failing doesn't skip the others. Failures are logged as `[SESSION_CLEANUP] <name> purge failed`.

---

## Data model

SQL tables (`src/config/schema.sql`):

- **users**: accounts (public `uuid`, internal numeric `id`), profile, admin flag, `disabled_at` (suspension), height/weight-unit prefs, `bf_formula_sex` (used only by the US-Navy body-fat formula) and `token_version` (bumped to invalidate every JWT at once).
- **user_settings**: one row per user containing every preference: hydration goal, cycle lengths, macro goals. Replaced three one-row-per-user settings tables.
- **refresh_tokens**: hashed, opaque, rotating refresh tokens chained by `family_id`, so presenting a spent token revokes the whole family.
- **exercises**: global exercise catalog, unique on name. Its muscle labels are only a fallback.
- **user_exercise_muscles**: each user's own muscle labels for a catalog exercise. Set, history, friend and program reads use the owner's labels when they exist.
- **programs** / **program_days** / **program_exercises**: one program per user, relational rather than a JSON blob. A day keeps its id across re-uploads so workout history keeps its muscle labels.
- **workouts** / **workout_sets**: workout sessions and individual sets (weight, reps, RIR, timing, rest, warm-up).
- **idempotency_keys**: stored responses for replayed offline writes, kept 48h.
- **measurements** / **metric_definitions**: every scalar body metric as `(metric, value, measured_at)` rows: weight, body fat, circumferences, hydration, and any metric the user defines. Replaced `body_weight`, `body_fat_measurements`, `body_measurements` and the custom-measurement pair.
- **soreness** / **soreness_follow_up**: a soreness episode and its check-ins. Replaced the parallel `doms_*` tables.
- **menstrual_cycle** · **injuries** · **muscle_notes** · **macros_intake**: one table each, all `user_id`-owned.
- **supplements** / **supplement_intake**: supplement definitions and intake.
- **progress_photos** / **progress_photo_blobs** / **progress_photo_thumbs** / **progress_photo_muscles**: metadata, image bytes and thumbnails in their own tables, and muscle-group tags.
- **friendships**: one row per pair, stored with `user_id < friend_id` and a `requested_by` column, so a duplicate request is a UNIQUE violation rather than a race.
- **friend_request_cooldowns**: remembers declined/cancelled requests so they can't be re-sent straight away.
- **user_blocks** / **user_reports**: blocks in both directions, and reports filed for the instance operator.
- **sharing_permissions**: per-friend access grants, with an optional JSON payload per grant.
- **joint_sessions** / **joint_session_participants** / **joint_session_invites**: synchronized co-workouts.
- **auth_throttle**: per-account failed-password counters and lockouts.
- **deleted_accounts**: uuids of deleted accounts, kept `BACKUP_RETENTION_DAYS` so a restored backup can't bring them back.

`schema.sql` is all `CREATE TABLE IF NOT EXISTS` and re-runs on every boot, so a new table needs no migration. Changes to _existing_ tables (new columns, indexes) go in `src/migrations/NNN_description.sql`. Each file runs at most once, tracked in a `_migrations` table, applied in filename order on every boot. `src/migrations/README.md` records each file's minimum supported prior schema. As of 0.1.0 there are no migrations, and `schema.sql` is the baseline.

---

## Configuration

Set these environment variables. Bun reads a `.env` file at the repo root by itself, so there is no `dotenv` dependency:

| Variable                      | Required | Default                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                        | no       | `5000`                                                                | HTTP/WS port                                                                                                                                                                                                                                                                                                                                                              |
| `DB_HOST`                     | no       | `localhost`                                                           | MySQL host                                                                                                                                                                                                                                                                                                                                                                |
| `DB_PORT`                     | no       | `3306`                                                                | MySQL port                                                                                                                                                                                                                                                                                                                                                                |
| `DB_USER`                     | **yes**  | none                                                                  | MySQL user                                                                                                                                                                                                                                                                                                                                                                |
| `DB_PASSWORD`                 | **yes**  | none                                                                  | MySQL password                                                                                                                                                                                                                                                                                                                                                            |
| `DB_NAME`                     | **yes**  | none                                                                  | Database name (auto-created if missing)                                                                                                                                                                                                                                                                                                                                   |
| `JWT_SECRET`                  | **yes**  | none                                                                  | Must be ≥ 32 characters                                                                                                                                                                                                                                                                                                                                                   |
| `JWT_EXPIRES_IN`              | no       | `15m`                                                                 | Access token lifetime (refresh tokens last 30 days)                                                                                                                                                                                                                                                                                                                       |
| `ALLOWED_ORIGINS`             | **yes**  | none                                                                  | Comma-separated CORS origins, matched exactly. `*` is **not** a wildcard here and is refused at boot, so list origins explicitly                                                                                                                                                                                                                                          |
| `NODE_ENV`                    | no       | none (Docker image: `production`)                                     | `production` masks error details, `development` shows stack traces                                                                                                                                                                                                                                                                                                        |
| `SERVER_FQDN`                 | no       | none                                                                  | Public domain name, advertised over mDNS (`_owngains._tcp`) and echoed on `GET /healthz`, so clients that find this server on the LAN can connect via this FQDN instead of the raw IP                                                                                                                                                                                     |
| `TRUST_PROXY_HOPS`            | no       | `0`                                                                   | Number of trusted reverse-proxy hops in front of the server. Must be a non-negative integer: `TRUST_PROXY_HOPS=true` is refused at boot rather than silently behaving like `0`. **Set this to `1` if you run behind nginx/Caddy/Traefik**, or the rate limiters will key every client into one shared bucket. Leave at `0` when the container's port is exposed directly  |
| `RATE_LIMIT_BYPASS_LOCAL_IPS` | no       | `false`                                                               | `true` skips the rate limiters for loopback/private-range client IPs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)                                                                                                                                                                                                                                             |
| `PHOTO_TOTAL_QUOTA_GB`        | no       | `0`                                                                   | Instance-wide progress-photo cap across every user, in GB (`0` disables). Once reached, uploads get `507` and an error is logged. Set it below the free space of the MySQL data directory on any box with open signup                                                                                                                                                     |
| `PHOTO_QUOTA_MB`              | no       | `1024`                                                                | Per-user progress-photo storage cap, in MB (`0` disables). Photo bytes are the only unbounded growth path on the box, and a full MySQL data directory fails every write on the instance, not just uploads                                                                                                                                                                 |
| `LOCAL_ONLY_FEATURES`         | no       | none                                                                  | Comma-separated features this deployment refuses to store, to save disk: `tracking`, `supplements` (case-insensitive, and an unrecognised name is refused at boot). Their routes answer `410` with `code: "FEATURE_LOCAL_ONLY"` and the `feature`, and the list is published on `GET /healthz`, which the app reads to keep those features logging on-device instead      |
| `REQUIRE_HEALTH_CONSENT`      | no       | `true`                                                                | Tracking, workout, program and sharing writes from a user with no recorded health consent answer `403 HEALTH_CONSENT_REQUIRED`. Reads and deletes remain open. Set `false` only while app builds that never send consent are still in use: you then store GDPR Art. 9 health data without the explicit consent it needs, and that is on you as the operator               |
| `REQUIRE_TERMS_ACCEPTANCE`    | no       | `true`                                                                | Writes (anything but `GET`/`HEAD`/`DELETE`) outside `/api/auth` from an account with no recorded Terms acceptance answer `403 TERMS_NOT_ACCEPTED`. The app records it through `PUT /api/auth/consent` right after signup                                                                                                                                                  |
| `LEGAL_PAGES_ENABLED`         | no       | `false`                                                               | Serves `/privacy-policy.html`, `/terms-of-service.html` and `/delete-account.html`, fetched from `LEGAL_PAGES_URL` and cached for an hour (the last good copy is kept if the fetch fails). These are the **official server’s** documents (they name its data controller), so leave it off on a self-hosted instance                                                       |
| `LEGAL_PAGES_URL`             | no       | `https://raw.githubusercontent.com/Superak0s/OwnGains-App/main/docs/` | Base URL the legal pages are fetched from (trailing slash required)                                                                                                                                                                                                                                                                                                       |
| `BACKUP_AGE_RECIPIENT`        | no       | none                                                                  | `owngains backup create` only: an [age](https://age-encryption.org) public key. Each dump is encrypted to it and written as `.sql.gz.age`                                                                                                                                                                                                                                 |
| `BACKUP_DIR`                  | no       | `./backups`                                                           | Directory `owngains backup` writes to (mode 700, `/backups` in Docker)                                                                                                                                                                                                                                                                                                    |
| `BACKUP_RETENTION_DAYS`       | no       | `30`                                                                  | Backups older than this are deleted by `backup prune`/`create`. Also how long deleted-account tombstones are kept (+2 days). Set it in the server's `.env`, not only the cron                                                                                                                                                                                             |
| `MYSQLDUMP`, `MYSQL`, `AGE`   | no       | `mysqldump` / `mysql` / `age`                                         | Commands the backup uses. They may include leading words, e.g. `docker exec -i -e MYSQL_PWD <ctr> mysqldump`                                                                                                                                                                                                                                                              |
| `REPORT_RETENTION_DAYS`       | no       | `365`                                                                 | User reports older than this are deleted by the cleanup job, and `0` keeps them forever                                                                                                                                                                                                                                                                                   |
| `DB_POOL_SIZE`                | no       | `8`                                                                   | MySQL connection pool size. Raise it for a busier deployment                                                                                                                                                                                                                                                                                                              |
| `DB_QUEUE_LIMIT`              | no       | `200`                                                                 | Queries allowed to wait for a pool connection. Past this, and on a DB timeout, lock-wait timeout or deadlock, requests get `503` with `Retry-After` instead of a `500`                                                                                                                                                                                                    |
| `DB_QUERY_TIMEOUT_MS`         | no       | `30000`                                                               | Server-side per-statement timeout (`0` disables): `max_execution_time` on MySQL (SELECTs only), `max_statement_time` on MariaDB (every statement). Boot-time schema and migration DDL runs without it                                                                                                                                                                     |
| `DB_SSL`                      | no       | `false`                                                               | `true` connects to MySQL over TLS, verifying the server certificate against Bun's bundled CAs                                                                                                                                                                                                                                                                            |
| `DB_SSL_CA`                   | no       | none                                                                  | Path to a PEM CA bundle for the MySQL server certificate. Setting it implies `DB_SSL=true`                                                                                                                                                                                                                                                                                |
| `AUTH_RATE_LIMIT`             | no       | `20`                                                                  | Per IP, per 15 min: **failed** `POST /api/auth/signin`, `PUT /api/auth/password` and `DELETE /api/auth/account` and `DELETE /api/auth/account/data` attempts. Every other `/api/auth` route (`/refresh`, `/me`, `/signout`, ...) is only under `API_RATE_LIMIT`                                                                                                           |
| `SIGNUP_RATE_LIMIT`           | no       | `20`                                                                  | Per IP, per 15 min: `POST /api/auth/signup` attempts, successful or not                                                                                                                                                                                                                                                                                                   |
| `API_RATE_LIMIT`              | no       | `200`                                                                 | Per IP, per minute, across all of `/api`                                                                                                                                                                                                                                                                                                                                  |
| `LARGE_BODY_RATE_LIMIT`       | no       | `20`                                                                  | Per user, per 15 min: requests with a body over 50 kB to the 2 MB-body routes (`/api/program/upload`, `/api/sharing/permissions`)                                                                                                                                                                                                                                         |
| `MDNS_ENABLED`                | no       | `true`                                                                | Advertise `_owngains._tcp` over mDNS for LAN discovery. **Set `false` on a cloud VM or any host with a public NIC**, where there is no LAN to discover it on and the responder would answer on the public interface                                                                                                                                                       |
| `WS_MAX_CONNECTIONS`          | no       | `1000`                                                                | WebSocket sockets (authenticated or not) across the server. Past it the upgrade gets `503`                                                                                                                                                                                                                                                                                |
| `WS_MAX_CONNECTIONS_PER_IP`   | no       | `20`                                                                  | WebSocket sockets (authenticated or not) per client IP, resolved via `TRUST_PROXY_HOPS` like `req.ip`. Past it the upgrade gets `429`                                                                                                                                                                                                                                     |
| `WS_MAX_SOCKETS_PER_USER`     | no       | `5`                                                                   | Simultaneous authenticated WebSockets per user (devices). Events go to all of them. Past the cap the oldest is closed with `1000 Replaced by new connection`. `1` restores the old one-device behaviour                                                                                                                                                                   |
| `BOOTSTRAP_ADMIN_USERNAME`    | no       | none                                                                  | When set, only the account with this username becomes admin on signup. When unset, the first-ever user does (the self-hosted default). **Set it on any publicly reachable instance**, or whoever signs up first gets `/api/admin`                                                                                                                                         |
| `BCRYPT_MAX_CONCURRENCY`      | no       | `2`                                                                   | Password hashes run at once on the libuv threadpool. Up to 100 more queue, and beyond that signin/signup answer `429 AUTH_BUSY`                                                                                                                                                                                                                                           |
| `HISTORY_TIMINGS_MAX`         | no       | `100`                                                                 | Page ceiling for `GET /api/sessions?includeTimings=true`. The app follows `nextCursor`. Raise it only for app builds that fetch history in one 1000-session request                                                                                                                                                                            |
| `METRICS_ENABLED`             | no       | `true`                                                                | Server metrics for admins: the request counters, `GET /api/admin/metrics` (JSON) and the `/admin/metrics` dashboard. `false` removes all three: nothing is counted, the page 404s and so does the endpoint (after the usual `/api/admin` auth check)                                                                                                                      |
| `METRICS_PAGE_ENABLED`        | no       | `true`                                                                | The `/admin/metrics` HTML dashboard only. `false` keeps the JSON endpoint for the app but serves no page. Ignored when `METRICS_ENABLED=false`                                                                                                                                                                                                                            |

> ⚠️ **Security:** do not commit real secrets. Rotate any credentials that have been checked into `.env`, and keep `.env` out of version control.

> ⚠️ **`TRUST_PROXY_HOPS`:** this defaults to `0` (don't trust `X-Forwarded-For`) because that is the safe default for a directly-exposed box. Otherwise a client can rotate the header to reset the auth rate limiter and brute-force passwords freely. If you terminate TLS at a reverse proxy, you **must** set `TRUST_PROXY_HOPS=1` so `req.ip` is the real client address. Combining `RATE_LIMIT_BYPASS_LOCAL_IPS=true` with `TRUST_PROXY_HOPS=0` behind a proxy makes _every_ request look like `127.0.0.1`, which disables both rate limiters for the entire internet. The server prints a loud warning at boot if you configure it that way.

---

## Running

### Development

```bash
bun install
bun run dev          # bun --watch, hot iteration
```

### Tests

```bash
bun run test                 # vitest run
bun run test:watch           # vitest watch mode
bun run test --coverage   # with a coverage report (v8, coverage/ is gitignored)
bun run smoke [url]          # live end-to-end check of a running server (default http://localhost:5000, or SMOKE_URL)
```

The suite needs a live MySQL and a `.env` at the repo root (the DB user needs `CREATE`/`DROP DATABASE`). `src/tests/global-setup.ts` drops and rebuilds the `<DB_NAME>_test` database, named after your `.env` `DB_NAME` (override with `TEST_DB_NAME`), and `src/tests/setup-env.ts` pins `JWT_SECRET`, `NODE_ENV`, rate limits and proxy settings so your `.env` tuning can't change results. The route tests drive the real Express app through supertest. Tests are in `src/features/**/__tests__/`, `src/__tests__/` and `src/tests/__tests__/`. There is no linter and no CI in this repo, so run `bun run build && bun run test` before releasing. `sonar-project.properties` is a local SonarQube config (localhost:9000) that reads `coverage/lcov.info`.

`bun run smoke` talks to an already-running server over real HTTP and WebSocket, the way the app does: health, sign-up/sign-in, refresh-token rotation and replay refusal, program upload, idempotent session start/set/end, WebSocket auth and account export. It signs up a throwaway `smoke_…` account and deletes it at the end, so it is safe to run against a live instance after an upgrade (mind the signup rate limit if you run it repeatedly). `--min-version x.y.z` also fails when the server is older than that. The app repo's `npm run check:all` builds and boots this server against a scratch `owngains_smoke` database and runs it for you.

### Production build

```bash
bun run build        # tsc + tsc-alias, copies src/config/schema.sql and src/migrations/ into dist/
bun run start        # bun dist/server.js
```

### Docker (recommended for self-hosting)

Running an instance for other people makes you the GDPR controller for their data, not the OwnGains developer: the official server's privacy policy does not cover your box. Publish your own privacy policy (who you are, what you store, retention, rights), and since workouts are health data under Art. 9, keep `REQUIRE_HEALTH_CONSENT` on and do your own DPIA if you open signup to strangers.

```bash
docker build -t owngains-server .
docker run -d --restart unless-stopped -p 5000:5000 --env-file .env \
  -v owngains-backups:/backups \
  --log-opt max-size=10m --log-opt max-file=3 \
  owngains-server
```

`.env` is not copied into the image. Pass it with `--env-file`. The image sets `NODE_ENV=production`, `BACKUP_DIR=/backups` (mode 700, owned by the non-root user, so a bind mount must be writable by it) and `UV_THREADPOOL_SIZE=8` (bcrypt, sharp, gzip and fs share libuv's pool, so override only if you raise `BCRYPT_MAX_CONCURRENCY`). mDNS does not reach the LAN from Docker bridge networking. Use `--network host` or set `MDNS_ENABLED=false`.

The `--log-opt` flags are not optional in practice: everything this server logs
goes to stdout, and Docker's default `json-file` driver has **no size limit**,
so the log grows without bound on the same disk as your MySQL data.

The official instance’s privacy policy promises request logs (this container’s and
the reverse proxy’s, which contain client IPs) are deleted within **14 days**. Size
rotation alone does not bound age on a quiet box, so on that host also rotate
by time: send Traefik’s access log to a file that `logrotate` rotates `daily`
with `rotate 14`, and delete the container’s rotated `*-json.log.*` files older
than 14 days from a daily cron (`find /var/lib/docker/containers -name "*-json.log.*" -mtime +13 -delete`). The live file is only cut at `max-size`, so keep that small enough to fill within 14 days at your traffic.

Security-relevant events are logged as warnings prefixed `[AUDIT]`: admin suspend/unsuspend and report reads (actor and target uuid), every mutating CLI command (`add`/`remove`, `passwd`, `suspend`/`unsuspend`, `purge-local-only --yes`, `backup restore`), refresh-token reuse (the whole session family is revoked) and sign-in lockouts. Alert on that prefix and on `Server error` (such as `docker logs -f <container> | grep --line-buffered -E "\[AUDIT\]|Server error"` piped to a notifier). GDPR gives 72 hours to report a breach, and nothing in the server sends alerts itself.

With `LEGAL_PAGES_ENABLED=true` the policy pages are served by the same process, so a Traefik router that matches the whole host (``Host(`owngains.example.com`)``) needs no change. If yours matches ``PathPrefix(`/api`)`` or similar, add ``|| Path(`/privacy-policy.html`) || Path(`/terms-of-service.html`) || Path(`/delete-account.html`)`` to its rule.

The image is a two-stage build (`oven/bun:1-alpine` for both build and run), runs as a non-root user under `tini`, exposes port 5000 and includes a `HEALTHCHECK` against `/healthz`. Point your MySQL env vars at a reachable database. The DB and schema auto-provision on first boot.

### Backups

`owngains backup` manages gzipped `mysqldump` backups in `BACKUP_DIR` (default `./backups`, mode 700, or `/backups` in the Docker image, where you should mount a volume), using the `DB_*` values from `.env`:

| Command                                            | Does                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `backup create`                                    | Writes `owngains-<UTC timestamp>.sql.gz`, then prunes                                                                   |
| `backup list`                                      | Lists backups, newest first, with size and date                                                                         |
| `backup verify <file> [--identity key.txt]`        | Decompresses (and decrypts) the whole file and checks both dumps in it finished                                         |
| `backup restore <file> --yes [--identity key.txt]` | Replaces every table in `DB_NAME` with the backup. Stop the server first. Without `--yes` it only says what it would do |
| `backup prune`                                     | Deletes backups older than `BACKUP_RETENTION_DAYS` (default `30`)                                                       |

`<file>` is a path, a file name in `BACKUP_DIR`, or `latest`. Run `create` nightly from the host's cron:

```cron
0 3 * * * docker exec <container> owngains backup create >> /var/log/owngains-backup.log 2>&1
```

The image includes `mysqldump`, `mysql` and `age`. Outside it they must be on `PATH`. If MySQL runs in another container, set `MYSQLDUMP="docker exec -i -e MYSQL_PWD <mysql-container> mysqldump"` (and `MYSQL=` likewise for restores). The official instance's privacy policy promises backups are kept at most 30 days, so don't raise the retention there. With `BACKUP_AGE_RECIPIENT` set, backups are encrypted and written as `.sql.gz.age`. Keep the private key off the box and pass it only to `verify`/`restore` with `--identity key.txt`.

Deleting an account records its uuid in `deleted_accounts` for `BACKUP_RETENTION_DAYS` plus two days (so a dump taken just before the deletion is always pruned first). That table is left out of the regular dump and appended as `INSERT IGNORE` rows, so a restore merges tombstones instead of rolling them back, and the cleanup job (on boot, then every 5 minutes) deletes every restored account that was erased after the backup was taken. Set `BACKUP_RETENTION_DAYS` in the server's `.env`, not only the backup cron's environment: tombstones must be kept as long as the oldest backup. Dumps made before this change contain no tombstones, so restoring one into a fresh database will bring back accounts deleted since.

### Releasing

`scripts/release.sh` bumps the version, commits & pushes to `origin main`, then builds and pushes `superak0s/owngains-server:latest` and `:<version>` to Docker Hub. Run it by hand, only when you mean to publish.

When the version is bumped, the script:

1. **Detects an empty changelog.** If `[Unreleased]` in `CHANGELOG.md` is empty, it leaves the file untouched and the release gets default notes. A malformed changelog stops the run before anything is written. Picking "keep current version" skips this check.
2. **Renames the section before the build.** `## [Unreleased]` becomes `## [0.4.0] - 2026-09-27`, with a fresh empty `[Unreleased]` above it, and the links at the bottom point at the new tag.
3. **Reverts the rename if the build fails.** `CHANGELOG.md` is restored from a copy taken just before, not from git, so uncommitted `[Unreleased]` entries are kept.
4. **Commits it with the version bump**, through the existing `git add .` step.
5. **Uses the changelog as the GitHub release notes.** That version's section goes to `gh release create --notes-file`. If the section is missing or empty, the notes fall back to "Release vX built on …". Without `gh` installed, the GitHub release is skipped.

---

## Changelog

Changes are recorded in [`CHANGELOG.md`](CHANGELOG.md), newest first, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each change adds its entry under `[Unreleased]`. `scripts/release.sh` renames that section to the new version at release time.

---

## Support

OwnGains and the official server at `owngains.superak0s.com` are built and run by one developer. If the app is useful to you, you can support development on [Ko-fi](https://ko-fi.com/superak0s).

---

## Admin

- The **first registered user** automatically becomes an admin, unless `BOOTSTRAP_ADMIN_USERNAME` is set, in which case only that username does.
- Manage the instance from the CLI (`list` shows every account with an `[admin]`
  marker, since `add`/`remove` need a username spelled exactly):
  ```bash
  bun run owngains list                       # every user, admins first
  bun run owngains create <username> <email> [pw] [--admin]   # omit the password to be prompted
  bun run owngains add <username>
  bun run owngains remove <username>          # refuses to demote the last admin
  bun run owngains passwd <username> [newpw]  # omit the password to be prompted
  bun run owngains reports [limit]            # user reports filed on this instance (max 1000)
  bun run owngains backup create|list|verify|restore|prune   # see Backups
  bun run owngains suspend <username> <reason>  # sign out everywhere and block sign-in (not admins), the reason is shown at sign-in
  bun run owngains unsuspend <username>
  bun run owngains purge-local-only [--yes]   # delete every user’s server copy of LOCAL_ONLY_FEATURES data
  ```
  `purge-local-only` is for data written before a feature became local-only:
  without `--yes` it only prints row counts.
  `passwd` is the only account-recovery path, since a self-hosted instance may have
  no mail server. It bumps `token_version`, so every device is signed out.
- In Docker, run it against the running container:
  ```bash
  docker exec <container> owngains list
  ```

### Metrics

Open `http://<your-server>:5000/admin/metrics` in a browser and sign in with an
**admin** account's username and password (the same ones the app uses). A
non-admin account is refused. The page refreshes itself (5s / 15s / 1m / off).
Filters, sorting and expanded rows are kept across a refresh. Sections:

- **Overview**: health and DB ping, uptime, requests, 5xx and 4xx rates, p99
  latency, memory, live WebSocket sockets, DB pool usage.
- **Errors**: which errors, not just how many.
  - every status code returned, with counts and share
  - **error kinds**, grouped by status + code + message, with the routes that
    produced them, first/last seen and the last request id (filter by 5xx, 4xx,
    rate limited, auth, or free text)
  - **recent server errors** with the _real_ error message, error type, code
    and stack trace, user, client IP and request id, even in production,
    where the client itself only sees "Internal server error"
  - **recent client errors** (bad logins, validation failures with the fields
    that failed, 404s, 429s, …)
  - the **server error log**: every `logger.error` line, including ones outside
    a request (DB outages, cleanup sweep failures, WebSocket errors).
  - **Clear error log** starts these lists over (request totals are kept).
- **Performance**: avg / p50 / p90 / p95 / p99 / max latency, event-loop
  delay, and per-minute charts for the last hour: requests, 5xx, 4xx, 429,
  p95, p99, average latency, event-loop p99, CPU, RSS, heap, WebSocket sockets.
- **Routes**: the top 100 routes (ids collapsed, e.g.
  `POST /api/sessions/:id/set`), sortable by requests, error %, 4xx, 5xx, avg,
  p50, p95, p99 and max, with each route's status codes.
- **Slow requests**: the last 50 requests that took 1s or longer.
- **Users & activity**: users (admins, suspended, new), active lifters
  (1/7/30 days), online now, workouts, sets, programs, friendships, reports,
  progress photos and their size, signed-in devices.
- **System**, **Database** (version, ping, pool, threads, query mix, slow
  queries, row-lock waits, deadlocks, temp tables on disk, buffer pool, size
  per table) and a **configuration** summary (switches only, no secrets).

The app (or a script) reads the same data from `GET /api/admin/metrics` with an
admin's `Authorization: Bearer <token>`, and can clear the error log with
`DELETE /api/admin/metrics/errors`. Anyone else gets `401`/`403`. Database
figures are cached for 15 seconds. Everything else is kept in memory, is bounded
in size, and resets on restart. Turn the feature off with
`METRICS_ENABLED=false`, or keep the endpoint but drop the web page with
`METRICS_PAGE_ENABLED=false`.

The page signs in through `POST /api/auth/signin`, so the usual sign-in rate
limit and per-account throttle apply. Tokens are kept in the tab's
`sessionStorage` (gone when the tab closes) and **Sign out** revokes the
refresh token. Serve it over HTTPS (your reverse proxy) on anything but a
trusted LAN, since the password is sent to it. Error entries include usernames
and client IPs, which is why the whole thing is admin-only.

---

## Connecting the app

The OwnGains app points at a server URL (default: the central instance, `https://owngains.superak0s.com`, overridable in the app's Settings), or finds a self-hosted box on the LAN over mDNS. It reads `localOnlyFeatures` from `GET /healthz` and keeps those features on the device, so on the central instance tracking and supplements never leave the phone. Set the app's server URL to your own instance to sync everything and keep all data under your control. Auth is JWT-based. Workouts, tracking data, and social/live features sync over REST + the `/ws` WebSocket.
