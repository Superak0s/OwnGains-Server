# Migrations

`src/config/schema.sql` is the one source of truth: it describes the current
shape of every table and re-runs idempotently on every boot, so a fresh
database is always up to date. Version 0.6.0 is the baseline: the migrations
before it were removed, so a database from an earlier release is not upgraded.

| File | Change | Minimum prior schema |
|---|---|---|

To alter an existing table on live boxes, add `NNN_description.sql` here,
zero-padded to three digits (files run in `localeCompare` order, each at most
once, tracked in `_migrations`), and note the minimum supported prior version in
this file. New tables go straight into `schema.sql`.
