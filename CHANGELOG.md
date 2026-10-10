# Changelog

All changes to this project are recorded here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

Add an entry under **Unreleased** in the same change that introduces it. At release time that section is renamed to the new version and date.

## [Unreleased]

### Fixed

- The purge of sign-ups that never accepted the Terms failed on MySQL with error 1093 and deleted nothing. It now selects the empty accounts first and deletes them by id.

### Internal

- CI runs the test suite against MariaDB 11.4, the database the official server runs, and the README names it as the supported database.

## [0.5.2] - 2026-10-10

### Added

- `MIN_APP_VERSION` (x.y.z) is published as `minAppVersion` on `GET /healthz`. The Google Play build of the app forces its in-app update when its own version is lower. Unset means never force, and a malformed value is refused at boot.

## [0.5.1] - 2026-10-10

### Added

- `GET /api/admin/metrics` takes `?window=15m|1h|6h|24h|7d|30d|all`, or `?window=custom&from=<date>&to=<date>` (default `1h`, anything else is 400). Request counts, status codes, latency percentiles, error kinds, error lists, logged errors and slow requests cover that window, and the response says which in `window`. The `/admin/metrics` page has a selector for it, with two date pickers for a custom range that reach back to the oldest kept data (`window.dataFrom`).
- Admin metrics are saved to the database (new `metrics_history` and `metrics_events` tables) once a minute and on shutdown, and kept 30 days, so a restart no longer resets the counts, charts and error lists.
- Optional Telegram alerts for bot traffic: with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set, one IP getting `BOT_ALERT_THRESHOLD` (default 60) or more `401`, `403`, `429` or unrouted `404` responses in a minute sends a message, at most once an hour per IP. `config.botAlertsEnabled` reports whether it is on.
- Telegram health alerts through the same bot: one message when p95 latency, p99 latency or the 5xx rate over the last 5 minutes reaches its limit (`ALERT_P95_MS` 500, `ALERT_P99_MS` 1000, `ALERT_ERROR_RATE_PCT` 1, `0` turns one off), and one when it is back under. Below `ALERT_MIN_REQUESTS` (30) requests nothing is judged. `config.healthAlerts` reports the limits.
- The database tables on the `/admin/metrics` page sort by name, rows, data size or index size when a column header is clicked.
- F5 and Ctrl/Cmd+R on the `/admin/metrics` page refresh the data without reloading the page. Ctrl+F5 and Ctrl+Shift+R still reload it.

### Changed

- The metrics response has `chart` (`bucketMinutes`, `slots`, at most 120 `points` over the window) in place of `history` (last hour), `errors.listsFrom` (where the kept error lists start, when the window reaches further back), `errors.log.inWindow`, and `app.sets.everLogged` in place of `app.sets.total`.
- Clearing the metrics error log keeps the error counts and charts. Only the error lists, slow requests and log lines start over.

### Fixed

- Metrics route labels no longer grow one row per value of a free-text path parameter (a split name in `DELETE /api/sessions/split/:split`): matched routes use their pattern.
- Metrics error totals no longer undercount once more than 300 distinct error kinds were seen. Counts come from the per-status totals, not a capped group table.
- The metrics dashboard's database figures no longer scan the whole `workouts` and `workout_sets` tables on every refresh.

### Security

- Failed and slow requests in the admin metrics, with the username, are now stored in the database for 30 days instead of in memory only. The client IP is never stored: it is shown only for errors still in memory. With Telegram alerts on, offending IPs are sent to Telegram.
- The request log line now includes the caller's user uuid, the acting trainer's uuid (when set) and the client IP, so a breach can be traced to the accounts whose data was fetched. These stay in the container log and are never sent to the database.

### Internal

- Tests for metrics persistence, custom windows, and Telegram bot and health alerts.
- README documents metrics storage, retention, the API and Telegram alert setup, and `.env.example` lists the Telegram and health alert variables.
- Migration `004_workouts_start_index.sql` adds the `workouts` index `idx_w_start_user (start_time, user_id)` for the active-user counts.

- CI pulls the MySQL service image from the AWS ECR Public mirror of Docker Official Images, not Docker Hub, to avoid its anonymous pull rate limit.

## [0.5.0] - 2026-10-10

### Added

- `POST /api/auth/google` signs in with a Google ID token, creating a new one or linking the existing account with the same verified email. Linking needs that account's `password` in the same request: without it the route answers 409 `GOOGLE_LINK_NEEDS_PASSWORD` with the account's username in `details`, and a wrong one is 401. It is mounted only when the new `GOOGLE_WEB_CLIENT_ID` variable is set, and answers 404 otherwise.
- `DELETE /api/auth/google` unlinks the Google account after checking `password`. An account created through Google has no password and gets 403 `NO_PASSWORD`.
- User objects include `hasPassword`, which is `false` for an account created through Google, and `googleLinked`.

### Changed

- `DELETE /api/auth/account`, `DELETE /api/auth/account/data` and an email change on `PUT /api/auth/profile` accept a fresh Google `idToken` instead of the password for an account linked to Google. `PUT /api/auth/password` answers 403 `NO_PASSWORD` for an account created through Google.
- The data export includes the linked Google account ID (`google_sub`).

### Fixed

- Signup, adding an exercise to a program and sending a joint workout invite are now all-or-nothing. A database error or crash part-way could leave a new account without its consent records or admin flag, an exercise on a split the program didn't list, or the previous invite declined with no new one sent.

### Security

- Failed `POST /api/auth/google` and `DELETE /api/auth/google` attempts count toward the per-IP credential limiter (`AUTH_RATE_LIMIT`), and a wrong password when linking counts toward that account's signin backoff.

### Internal

- Migration `003_google_sub.sql` adds `users.google_sub` and `users.has_password`.
- New dependency `google-auth-library` verifies Google ID tokens.

- GitHub Actions CI builds and runs the test suite against MySQL on pushes to `main` and on pull requests.
- Project `.mcp.json` adds the GitHub MCP server, which needs a `GITHUB_PAT` environment variable.
- The programs edge tests inject failures into transaction connections too, and cover the `addExercise` rollback.

## [0.4.0] - 2026-10-09

### Added

- New `watch_progress` WebSocket event pushed to friends watching a workout when the lifter records, edits or deletes a set or ends the session. The payload is `{ friendId, sessionId, liveSession }`, where `liveSession` is the same object `GET /api/sharing/watch/friend/:friendId/session/:sessionId/live` returns, or `null` once the session has ended. It only reaches watchers who polled `/live` recently and whose `watch_session` grant and friendship are still valid, re-checked on every push, and never the lifter's own sockets.

### Changed

- A watch now stays active for 150s after the last `/live` poll instead of 60s, so apps that rely on `watch_progress` can poll every 60s.

### Fixed

- Joint workout progress updates that send `exerciseNames` (over HTTP or the WebSocket) no longer fail with a 500 on MariaDB.
- Two `owngains backup create` runs started in the same second (for example from two cron entries) no longer write into the same file and leave an undecryptable backup.

### Internal

- Tests for `watch_progress` pushes: the snapshot matches `/live`, idle watchers and the lifter get nothing, and a revoked grant stops pushes.
- Raised test coverage with edge-case suites for the CLI, backups, boot and shutdown, env and database provisioning, validation, idempotency, the WebSocket server, the session cleanup job, metrics, legal pages, password hashing, middleware, and the auth, user, programs, workouts, demo, tracking, progress photo, supplements, friends and sharing models and routes.
- Moved `runCli` into `src/tests/helpers.ts` and added `src/tests/fakebin.mjs`, a stand-in for `mysqldump` and `mysql` in backup tests.
- `src/server.ts` exports `start`, `shutdown`, `main` and `getLanInterface` so tests can run boot and shutdown in-process. Its per-user rate-limit keys are built with a template literal, with no change in behavior.
- Removed fallbacks and guards that could never run (in `src/ws/wsServer.ts`, the workouts, demo, auth, user, menstrual and progress photo models, the measurements pivot, the signup route, the throttle and macros models, the trainer audit log line, the rate-limit bypass IP check and every `req.body ?? {}`), simplified the program split-order and workout history sort comparators, deleted the unused `hasPermission` from the sharing model, and marked race-only branches with `v8 ignore`.
- The progress photo model now rejects an insert without 1 to 20 muscle groups itself, matching the route.
- Fixed flaky tests that shared database state across parallel files: the boot test no longer arms the real shutdown backstop timer or session sweep, the sweep lock tests take the lock before seeding, the last-admin CLI check moved to the mocked CLI suite (no more demoting every admin), and the purge tests age a joint session only after its participants exist.
- Added a Claude Code PostToolUse hook that reminds Claude to update README.md after a change to feature routes or models, `src/routes.ts`, env config, the schema, the WebSocket server or jobs, and a user-invoked `/readme-audit` skill that checks README.md against the code and fixes the drift.
- README brought in line with the code: demo fill route and `DEMO_FILL_RATE_LIMIT`, `consent_events` and `demo_rows` tables, existing migrations, the WebSocket pre-auth frame cap, `docker-compose.yml`, the k6 load test and `sonar:scan`, and the Docker image no longer described as setting `UV_THREADPOOL_SIZE`.

## [0.3.2] - 2026-10-07

### Changed

- `POST /api/sessions/demo` now adds one demo friend per sharing permission, each named after what it grants the caller (History, Analytics, Program, Joint, Watch, Trainer), plus All (every permission), None (friends with nothing shared) and a Pending request. Program shares an Upper/Lower plan.

### Internal

- Added `bun run sonar:scan` (`scripts/sonar-scan.sh`), a SonarQube scan that reads `SONAR_TOKEN` from the environment or `.env`.
- Fixed the SonarQube findings: `node:` builtin imports, `Number.*` helpers, unused imports and redundant assertions removed, `Set` lookups, `.at(-1)`, flattened nested ternaries and template literals, long functions split into helpers (CLI commands, validators, error handler, migrations, idempotency, data export, program upload, demo data, WebSocket message handling), and options objects in place of long parameter lists.

## [0.3.1] - 2026-10-06

### Changed

- Running from source now needs only Bun, not Node. `bun run start`, `dev`, `owngains`, `smoke`, `build` and `test` all run on Bun, the same runtime as the Docker image, and Bun loads `.env` from the repo root by itself.
- `POST /api/sessions/:id/set` on a workout that has already ended now stores the set and answers `200`, moving the workout's end time forward, where it answered `409 SESSION_ALREADY_ENDED`. The app drops a queued set on that error, so a set logged just after the 30-minute auto-end was lost. A trainer posting for a trainee still gets the `409`.
- `owngains backup restore` now verifies the backup and saves the current database as a new backup before replacing it. A truncated file stops the restore, and restoring the wrong backup can be undone.
- `HISTORY_TIMINGS_MAX` now defaults to `100` (was `1000`). The app follows `nextCursor`, so an app build that fetches history in one request gets only its newest 100 workouts unless the operator raises it.
- `POST /api/tracking/bodystats/bodyfat/log` now answers `201`, like the other tracking creates, where it answered `200`.

### Removed

- `AUTH_LEGACY_REFRESH` and `AUTH_LEGACY_DATA_WIPE`. `POST /api/auth/refresh` always needs a `refreshToken`, and `DELETE /api/auth/account/data` always needs `password` (`400 PASSWORD_REQUIRED` without one). The admin metrics no longer report the two flags.

### Fixed

- Deleting any account (including the throwaway one `bun run smoke` creates) no longer erases other users' own muscle labels for exercises they have labelled but not used in a logged set or their current program.
- Removing demo data no longer clears a user's real height when it happens to be the demo value of 178 cm. It is cleared only when the demo filled it in.
- The daily purge of accounts that never accepted the Terms no longer deletes accounts older than 30 days that hold any data (body tracking, photos, settings and the like). It used to check programs and workouts only.
- Two users uploading programs that share an exercise name at the same moment no longer deadlock, which answered one of them `503`.
- `owngains backup prune` now exits with code `1` and prints an error when it leaves no backups, so a cron job reports that backups stopped being written. Backups are now ordered by the timestamp in their file name, not file modification time.

### Security

- `GET /api/auth/account/export` no longer includes the internal user id of a trainer who acted on the account (`idempotency_keys.actor_id` is now a uuid, or null for the owner) or the raw account rows of the caller's demo friends.
- `POST /api/friends/request` to a suspended or demo account now answers `404`, like an unknown username, so it no longer confirms the account exists.
- Muscle labels sent with a set or a program upload are stored only as the sender's own. They no longer fill the shared exercise catalog, so one account can't choose the labels other users see. Users who never labelled an exercise see the labels already in the catalog, or none.
- Deleting an account only removes catalog exercises that account used, so another user's set or program saved at the same moment no longer fails.
- Every database connection now runs with `STRICT_TRANS_TABLES` added to `sql_mode`, so a value too long or out of range for its column is refused instead of being silently cut and stored. MySQL and MariaDB already default to it, so this only changes servers whose `my.cnf` turned it off.

### Internal

- `bun run test` now refuses to start when `.env` `DB_NAME` is the test database (`TEST_DB_NAME`). The suite drops that database, so it was erasing the dev server's accounts on every run.
- The test database now defaults to the `.env` `DB_NAME` plus `_test` instead of `owngains_test`.
- Removed `tsx`. Added `bunfig.toml` with `[run] bun = true`, so tool shims (vitest, tsc-alias) run on Bun too, and moved `release.sh`, `changelog.mjs` and the `.claude/` hooks off `node`.
- Added data-isolation regression tests (`exportIsolation.test.ts`, `suspendedTarget.test.ts`, plus cases in `exerciseCatalog.test.ts` and `auth.routes.test.ts`).
- Added data-loss regression tests (`workouts/__tests__/dataLoss.test.ts`, `auth/__tests__/unconsentedPurge.test.ts`).
- Moved `purgeUnconsentedAccounts` to `user.model.ts`, which now builds its "holds no data" check from the schema's user-owned tables.
- Deleted `report.html`, a k6 load-test report committed by mistake.
- Replaced every explicit `any` in `src/` (models and tests) with concrete types. `getMetricGroups` now returns its metrics under `values` instead of as loose top-level keys.

## [0.3.0] - 2026-10-06

### Changed

- `POST /api/tracking/bodystats/bodyfat/log` accepts a percentage with no tape measurements (`measurements` null or absent), as Health Connect readings send. The entry is stored with null `waist`, `neck` and `hip`, which `GET /api/tracking/bodystats/bodyfat/log` returns as is. A request without `percentage` now fails with "percentage is required".

- `BCRYPT_MAX_CONCURRENCY` must be an integer of at least 1. A malformed value now fails at boot instead of quietly falling back to 2.
- Latency figures in `GET /api/admin/metrics` and on the metrics page (`avgMs`, `p50Ms` to `p99Ms`) now come from Node's built-in HDR histograms, accurate to about 1%, so they can differ slightly from the old fixed-bucket estimates. The boot banner for the metrics page is now one log line instead of a box.

### Removed

- The `DB_CONNECT_TIMEOUT_MS`, `HTTP_KEEPALIVE_TIMEOUT_MS`, `HTTP_HEADERS_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `WS_AUTH_TIMEOUT_MS` and `METRICS_SLOW_MS` variables. Their defaults (10s, 65s, 66s, 60s, 2s and 1s) are now fixed, and a value set in `.env` is ignored.

### Internal

- Removed `scripts/reset-changelog.mjs` and `pnpm changelog:reset`.
- Removed dead code (`areFriends`, `resetMetrics`, `clearDbSnapshotCache`, `rollMinuteForTest`, `readTrustProxyHops`), the one-line weight wrappers in `bodyStats.model.ts`, the 500-user chunking in WebSocket token revalidation, and `export` from about 40 symbols only used in their own file.
- Switched the package manager and the Docker image runtime from pnpm and Node to bun (`bun.lock`, docs, typecheck hook, scripts, and the image now runs `bun dist/server.js`). The build copies assets with `scripts/copy-assets.mjs` so it also works under Bun on Windows.
- `scripts/release.sh` output is colored like the app's release script, with a summary header. A failed or Ctrl+C'd run now restores `package.json` from a copy (it used to `git checkout` it, discarding uncommitted edits, and Ctrl+C reverted nothing).
- `config/database.ts` uses `import.meta.dirname` instead of building `__dirname` from `fileURLToPath`.

- `scripts/loadtest.k6.js` now defaults to a realistic `lifter` mode (app launch fetches, a WebSocket held for the visit, ~45 min workouts, token refresh, friends spectating) that ramps up in plateaus and aborts at the first one that breaks, to find max concurrent users (or, with `DURATION`, starts all users at once for that long). The old every-feature loop remains as `MODE=coverage`, and teardown now signs in again so accounts are deleted after runs longer than the token lifetime.

## [0.2.0] - 2026-10-05

### Internal

- The WebSocket server loads the real `ws` package by file path, so its 8KB `maxPayload` cap also holds when the server runs on Bun (which otherwise swaps in its own `ws` and ignores the cap).

## [0.1.2] - 2026-10-04

### Added

- `POST /api/sessions/demo` with `{ split?, days: [{ dayNumber, dayTitle, exercises: [{ name, sets, primaryMuscles?, secondaryMuscles? }] }] }` generates five weeks of demo workouts plus three demo friends (with shared history and analytics), one pending friend request, and about five weeks of tracking and supplement entries with 30 placeholder progress photos (three per muscle for ten muscles) and a height of 178 cm when none is set (only for features not in `LOCAL_ONLY_FEATURES`), in one transaction. It replaces any earlier demo data and returns `{ sessions, sets, friends, tracking }`. Rate limited per account by `DEMO_FILL_RATE_LIMIT` (default 5 per 15 minutes).

### Changed

- `DELETE /api/sessions/demo` now also deletes the caller's demo friends and demo tracking/supplement entries and photos, unsets the demo height, and returns `deletedFriends` and `deletedTracking` alongside `deletedCount`.
- Demo friend accounts are left out of the admin metrics user counts. They are suspended, so they cannot sign in or appear in search.

### Internal

- Migration `002_demo_friends.sql` adds `users.demo_owner_id`.
- New `demo_rows` table records which tracking, supplement and photo rows (and the height) were created as demo data.
- Bundled 30 black placeholder demo photos labeled with their muscle and angle, copied into `dist` by the build.

## [0.1.1] - 2026-10-02

### Added

- Initial release.

### Changed

- `POST /api/admin/users/:userId/suspend` now requires a `reason` (1 to 500 characters, `400` otherwise), and `owngains suspend` takes it as `owngains suspend <username> <reason>`. The reason is shown to the user in the `ACCOUNT_DISABLED` sign-in error.

### Fixed

- The startup banner no longer prints the metrics URL as `https://https://…` when `SERVER_FQDN` includes the scheme.

### Security

- `/api/settings` is now part of the `tracking` group: it needs health consent for writes and answers `410 FEATURE_LOCAL_ONLY` when `tracking` is local-only, so a box running `LOCAL_ONLY_FEATURES=tracking` no longer stores menstrual cycle length.
- Withdrawing health consent (and `owngains purge-local-only` for tracking) now also erases the settings row. Withdrawal also erases stored idempotency replays, which kept copies of the workout rows they created.
- Terms acceptances and health consent grants and withdrawals are now kept as an append-only history per account (`consent_events`), deleted with the account.
- Sent friend requests and the blocked list now show the other user's username in place of their display name, which only friends see.
- A friend's active workout (`/api/sharing/joint-sessions/status` and the single-friend route) is only shown to friends they granted `watch_session`, `joint_session` or `trainer`. Everyone else sees no active session.
- `POST /api/sharing/joint-sessions/invite` now needs a `joint_session` grant from the invitee (`403` otherwise).
- Admin report reads and every mutating `owngains` CLI command are logged with an `[AUDIT]` prefix.
- Account deletion now also removes custom exercises no remaining workout or program references.
- The sample `docker-compose.yml` caps the server's container log at 5 × 10 MB.

### Internal

- Migration `001_suspension_reason.sql` adds `users.disabled_reason`.
- README: operator responsibilities for self-hosted instances and for `REQUIRE_HEALTH_CONSENT=false`.
- Fixed a flaky exercise-records test whose 2024-dated workouts were closed by the concurrent stale-session sweep test.

[Unreleased]: https://github.com/Superak0s/OwnGains-Server/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.5.2
[0.5.1]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.5.1
[0.5.0]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.5.0
[0.4.0]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.4.0
[0.3.2]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.3.2
[0.3.1]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.3.1
[0.3.0]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.3.0
[0.2.0]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.2.0
[0.1.2]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.1.2
[0.1.1]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.1.1
