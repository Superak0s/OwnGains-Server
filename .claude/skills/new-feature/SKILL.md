---
name: new-feature
description: Scaffold a new OwnGains-Server feature (the routes/model file pair, its schema table, its router mount, and its test file) following this repo's conventions.
disable-model-invocation: true
---

# New feature

Ask for the feature name (camelCase, e.g. `sleepLog`) and its mount path if not given, then work
through the checklist below. Create a todo per step.

## 1. Decide where it goes

- A standalone domain: `src/features/<name>/`
- A per-metric tracker: `src/features/tracking/<name>/`. It must then be mounted inside
  `serves("tracking")` in `src/routes.ts`, so a box with `LOCAL_ONLY_FEATURES=tracking` stores none of it.
- A social sub-feature: `src/features/social/<name>/`

## 2. The table

A new table goes into `src/config/schema.sql` as another `CREATE TABLE IF NOT EXISTS` block. That file
re-runs on every boot, so existing deployments pick it up with no migration. Only changes to an
*existing* table go in a new `src/migrations/NNN_description.sql`. Getting this backwards means the
change silently never applies to a database that already has the table.

Follow the existing blocks: `id INT AUTO_INCREMENT PRIMARY KEY`, a
`user_id INT NOT NULL` with `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`,
snake_case columns, and an index on the columns the list query filters and sorts by.

## 3. `<name>.model.ts`

```ts
// <Name> model

import { pool } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { NotFoundError } from "@/middleware/errorHandler.js"

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface <Name>Record extends RowDataPacket {
  id: number
  // ...
}

export async function log<Name>(userId: number, value: number): Promise<{ id: number }> {
  const [result] = await pool.execute<ResultSetHeader>(
    "INSERT INTO <table> (user_id, value) VALUES (?, ?)",
    [userId, value],
  )
  return { id: result.insertId }
}

export async function getAll<Name>s(userId: number, limit: number): Promise<<Name>Record[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, value, logged_at AS loggedAt FROM <table> WHERE user_id = ? ORDER BY logged_at DESC LIMIT ?",
    [userId, limit],
  )
  return rows as <Name>Record[]
}
```

Rules that nothing else enforces:

- `?` placeholders only, never interpolation.
- `RowDataPacket[]` for SELECT and `ResultSetHeader` for writes.
- Every query scoped to `user_id`.
- `.js` on every local import even though the source is `.ts`.
- `@/` for anything two or more levels up, a plain `../` for a sibling.

## 4. `<name>.routes.ts`

```ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import { log<Name>, getAll<Name>s } from "./<name>.model.js"

const router: Router = Router()

const LIST_LIMIT = (req: Request) => queryLimit(req, { def: 100, max: 500 })

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
  const { value } = req.body
  if (value === undefined || value === null) throw new ValidationError("Value is required")
  const result = await log<Name>(req.user!.id, value)
  res.status(201).json({ success: true, data: result })
})

router.get("/", async (req: Request, res: Response) => {
  const rows = await getAll<Name>s(req.user!.id, LIST_LIMIT(req))
  res.json({ success: true, data: rows })
})

export default router
```

- Reuse `parseIntParam` and `queryLimit` from `src/middleware/validation.ts`. Never hand-roll id
  parsing or limit clamping.
- Validators throw `ValidationError` synchronously and Express 5 forwards thrown errors, so no
  `try`/`catch` + `next(err)` wrapper.
- Static paths are declared before dynamic `/:id` routes.
- Responses are always `{ success: true, data }`.

## 5. Mount it

Add the import and the `app.use("/api/...", ...)` line to `src/routes.ts`, inside the right
`serves(...)` block. `/api/version` there is an inline `app.get`, not a router. Leave it alone.

## 6. Test it

Add `src/features/<path>/__tests__/<name>.routes.test.ts`, modelled on a neighbouring test. The suite
drives the real `app` through supertest against a live MySQL that `src/tests/global-setup.ts` drops and
rebuilds, so `bun run test` needs the `.env` credentials. Run it and report the actual output.
