# Changelog

All changes to this project are recorded here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

Add an entry under **Unreleased** in the same change that introduces it. At release time that section is renamed to the new version and date.

## [Unreleased]

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

[Unreleased]: https://github.com/Superak0s/OwnGains-Server/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.2.0
[0.1.2]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.1.2
[0.1.1]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.1.1
