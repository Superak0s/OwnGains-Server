# Changelog

All changes to this project are recorded here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

Add an entry under **Unreleased** in the same change that introduces it. At release time that section is renamed to the new version and date.

## [Unreleased]

### Changed

### Internal

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

[Unreleased]: https://github.com/Superak0s/OwnGains-Server/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Superak0s/OwnGains-Server/releases/tag/v0.1.1
