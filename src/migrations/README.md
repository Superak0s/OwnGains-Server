# Migrations

`src/config/schema.sql` is the one source of truth: it describes the current
shape of every table and re-runs idempotently on every boot, so a fresh
database is always up to date. Version 0.1.0 is the baseline.

| File | Change | Minimum prior schema |
|---|---|---|
| `001_suspension_reason.sql` | `users.disabled_reason` | 0.1.0 |

To alter an existing table on live boxes, add `NNN_description.sql` here,
zero-padded to three digits (files run in `localeCompare` order, each at most
once, tracked in `_migrations`), and note the minimum supported prior version in
this file. New tables go straight into `schema.sql`.
