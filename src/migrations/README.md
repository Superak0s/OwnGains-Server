# Migrations

`src/config/schema.sql` is the one source of truth: it describes the current
shape of every table and re-runs idempotently on every boot, so a fresh
database is always up to date. Version 0.6.0 is the baseline: the migrations
before it were removed, so a database from an earlier release is not upgraded.

| File | Change | Minimum prior schema |
|---|---|---|
| `001_local_date.sql` | Adds `local_date` to `supplement_intake` and `soreness`, backfilled from the UTC timestamp, so rows from before it keep their UTC day. | 0.6.0 |
| `002_metrics_events_no_usernames.sql` | Blanks the usernames already saved in `metrics_events`, which now keeps them in memory only. | 0.6.0 |
| `003_report_reason_underage.sql` | Adds `underage` to `user_reports.reason`. | 0.6.0 |

To alter an existing table on live boxes, add `NNN_description.sql` here,
zero-padded to three digits (files run in `localeCompare` order, each at most
once, tracked in `_migrations`), and note the minimum supported prior version in
this file. New tables go straight into `schema.sql`.
