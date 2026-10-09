---
name: readme-audit
description: Audit README.md against the code (routes, env variables, tables, WS events, jobs, CLI and scripts) and fix every place where it has drifted.
disable-model-invocation: true
---

# README audit

The code is the source of truth. Compare each README section with what it describes, list the
drift, then fix README.md. Create a todo per section.

## 1. API (`## API`)

- Every `app.use("/api/...")` in `src/routes.ts`, plus the inline `app.get("/api/version")` there,
  and which groups `LOCAL_ONLY_FEATURES` switches off (`serves(...)`).
- Every `router.get|post|put|patch|delete(` in `src/features/**/*.routes.ts`. Join each path to its
  mount prefix. Flag routes the README misses, and README routes that no longer exist.
- Trainer mode: which routers mount `applyTrainerContext`, and which routes use `denyTrainer`.
- Idempotent routes (`idempotent` middleware) match what the README says.

## 2. Configuration (`## Configuration`)

- Every `process.env.X` / `Bun.env.X` read under `src/` (mainly `src/config/env.ts`). Check the name,
  default and the required ones listed in `src/server.ts`. Cross-check `.env.example` too.

## 3. Data model (`## Data model`)

- Every `CREATE TABLE IF NOT EXISTS` in `src/config/schema.sql`. Flag missing or removed tables.

## 4. WebSockets, background jobs

- Message `type`s handled and sent in `src/ws/wsServer.ts`, its limits (timeouts, caps, sizes).
- Each job in `src/jobs/` with its interval.

## 5. Running, Admin, Backups, Releasing

- `package.json` scripts, `owngains` CLI subcommands in `src/owngains.ts`, `backup` subcommands in
  `src/utils/backup.ts`, the Docker files, and `scripts/`.

## 6. Fix

- Present the drift as a short list grouped by section, then edit README.md. Keep its existing
  structure and tone. Don't invent behaviour you didn't see in the code.
- Follow the Prose Style rules in CLAUDE.md (no dashes as punctuation, no semicolons, literal verbs).
- Add one `### Internal` line to `CHANGELOG.md` under `[Unreleased]` ("README brought in line with
  the code"), or a `Fixed` entry if the README documented behaviour wrongly in a way an operator relies on.
