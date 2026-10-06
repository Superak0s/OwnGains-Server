# Changelog

All changes to this project are recorded here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

Add an entry under **Unreleased** in the same change that introduces it. At release time that section is renamed to the new version and date.

## [Unreleased]

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

[Unreleased]: https://github.com/Superak0s/OwnGains-Server/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.3.1
[0.3.0]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.3.0
[0.2.0]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.2.0
[0.1.2]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.1.2
[0.1.1]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.1.1
