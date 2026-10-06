import mysql, { Pool, PoolConnection } from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import type { Connection as CoreConnection } from "mysql2";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../middleware/errorHandler.js";
import { envBool, envInt } from "./env.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Required environment variable "${name}" is not set`);
  return value;
}

/**
 * DB_SSL / DB_SSL_CA: TLS to MySQL for a database that isn't on the same box
 * (a managed instance, another host on an untrusted network). Off by default:
 * the self-hosted setup talks to MySQL over loopback or a private Docker
 * network. Setting DB_SSL_CA alone implies DB_SSL=true. The server certificate
 * is always verified: `rejectUnauthorized: false` would make TLS decorative.
 * Without DB_SSL_CA, Node's bundled public CAs are used (fine for a managed
 * database with a publicly-signed certificate).
 */
function sslOptions(): { ca?: string; rejectUnauthorized: true } | undefined {
  const caPath = process.env.DB_SSL_CA?.trim();
  if (!envBool("DB_SSL", false) && !caPath) return undefined;
  return {
    rejectUnauthorized: true,
    ...(caPath ? { ca: fs.readFileSync(caPath, "utf8") } : {}),
  };
}

const ssl = sslOptions();

/**
 * Server-side statement timeout in ms (0 disables). A runaway query otherwise
 * ties up one of the pool's few connections for as long as it runs, and every
 * request queued behind it waits too. Applied to each pooled connection below.
 * Boot DDL (schema + migrations) switches it off on its own connection.
 */
export const queryTimeoutMs = envInt("DB_QUERY_TIMEOUT_MS", 30_000);

export const pool: Pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: requireEnv("DB_USER"),
  password: requireEnv("DB_PASSWORD"),
  database: requireEnv("DB_NAME"),
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  // Defaults sized for the box this server targets: one small, often
  // single-core machine serving its owner plus a few invited friends. Twenty
  // concurrent queries on one core is thrash, not throughput, and every idle
  // connection carries its own MySQL thread buffers and prepared-statement
  // cache. Eight rather than six leaves headroom above the widest fan-out in
  // the codebase (getSorenessStats issues six in parallel). queueLimit absorbs
  // anything past that. DB_POOL_SIZE raises it for a bigger deployment.
  connectionLimit: envInt("DB_POOL_SIZE", 8, 1),
  // Bounded rather than unlimited (0): under a real overload, requests should
  // fail fast with an error the client can retry (errorHandler turns it into
  // 503 + Retry-After), not queue indefinitely and pile up memory/timeouts.
  queueLimit: envInt("DB_QUEUE_LIMIT", 200),
  // pool.execute prepares one server-side statement per distinct SQL text per
  // connection, and MySQL's global max_prepared_stmt_count (16,382 by default)
  // is shared by every connection. mysql2's per-connection default of 16,000
  // lets two connections exhaust it between them, after which every execute()
  // on the server fails. An LRU of 256 keeps the hot statements cached and
  // closes the ones it evicts. The long tail (IN lists sized by a result set,
  // optional SET columns) cycles through it rather than piling up.
  maxPreparedStatements: 256,
  ...(ssl ? { ssl } : {}),
  dateStrings: true,
  // DECIMAL columns otherwise arrive as strings, so weights and volumes would
  // serialize into JSON quoted and force every client to re-parse them.
  decimalNumbers: true,
});

/**
 * The statement that sets a connection's server-side timeout. MySQL and
 * MariaDB spell it differently: MySQL's `max_execution_time` is milliseconds
 * and bounds read-only SELECTs only. MariaDB's `max_statement_time` is seconds
 * and bounds every statement. mysql2 sets `_isMariaDB` on the core connection
 * from the handshake's server version string.
 */
function statementTimeoutSql(conn: unknown, ms: number): string {
  const core = (conn as { connection?: unknown }).connection ?? conn;
  return (core as { _isMariaDB?: boolean })._isMariaDB
    ? `SET SESSION max_statement_time = ${ms / 1000}`
    : `SET SESSION max_execution_time = ${ms}`;
}

// Every timestamp this server writes is UTC (see formatDateForMySQL), so the
// connection must read them back as UTC too, otherwise NOW(), CURDATE() and
// the CURRENT_TIMESTAMP column defaults sit at the box's local offset and
// "today" comparisons drift by that many hours. Pinned here rather than left
// to the operator's my.cnf, which usually says SYSTEM.
// Callback form deliberately: pool.on("connection") hands over the *core*
// (callback-style) connection, and a callback-less query there returns a Query
// EventEmitter that does `emit("error", err)` on failure. With no listener that
// throws out of the emitter as an uncaughtException, which shutdown()s the
// process, so a MySQL restart while the pool was opening a connection killed
// the server. Passing a callback routes the error to it instead.
// The typings say PoolConnection (promise flavour). The runtime hands over the
// callback-style core connection, which is the whole point here.
pool.on("connection", (conn) => {
  const connection = conn as unknown as CoreConnection
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err)
      logger.warn(
        "Could not pin connection time_zone to UTC:",
        (err as Error).message,
      );
  });
  // Without strict mode a too-long or out-of-range value is silently cut down
  // and stored with a warning, so a user's data is changed instead of refused.
  // MySQL and MariaDB default to strict, but a my.cnf can turn it off.
  connection.query(
    "SET sql_mode = IF(FIND_IN_SET('STRICT_TRANS_TABLES', @@sql_mode), @@sql_mode, " +
      "CONCAT_WS(',', NULLIF(@@sql_mode, ''), 'STRICT_TRANS_TABLES'))",
    (err) => {
      if (err)
        logger.warn("Could not enable strict sql_mode:", (err as Error).message)
    },
  );
  if (queryTimeoutMs > 0)
    connection.query(statementTimeoutSql(conn, queryTimeoutMs), (err) => {
      if (err)
        logger.warn(
          "Could not set the connection's statement timeout:",
          (err as Error).message,
        );
    });
});

/**
 * Run `fn` inside a transaction on one pooled connection: commit when it
 * resolves, roll back when it throws, release either way. Every multi-statement
 * write used to hand-roll this getConnection/begin/commit/rollback/release
 * block, and one of them rolled back twice on its own error path.
 */
export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export function formatDateForMySQL(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date)
  // toISOString throws RangeError on an invalid date: an unvalidated client
  // timestamp used to reach the error handler as a 500 for what is a 400.
  if (Number.isNaN(d.getTime()))
    throw new ValidationError(`Invalid timestamp: ${String(date)}`)
  return d.toISOString().slice(0, 19).replace("T", " ")
}

/**
 * Parse a DATETIME the driver handed back. The pool runs with
 * `dateStrings: true` and everything is stored UTC, but "2026-09-08 22:45:33"
 * has no zone, so a bare `new Date(...)` reads it as local time and shifts
 * it by the machine's offset. Date-only and already-zoned values pass through.
 */
export function parseMySQLDate(value: string | Date): Date {
  if (value instanceof Date) return value
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? new Date(value.replace(" ", "T") + "Z")
    : new Date(value)
}

async function createDatabaseIfNotExists(): Promise<void> {
  const dbName = requireEnv("DB_NAME");
  // Temporary connection for CREATE DATABASE. Never log this config object.
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: requireEnv("DB_USER"),
    password: requireEnv("DB_PASSWORD"),
    port: Number(process.env.DB_PORT) || 3306,
      ...(ssl ? { ssl } : {}),
  });
  try {
    // DB_NAME is the operator's own, not user input, but an unescaped backtick
    // turns a typo into a confusing syntax error at boot instead of a clear one.
    await connection.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName.replaceAll("`", "``")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    logger.info(`✓ Database '${dbName}' verified/created`);
  } finally {
    await connection.end();
  }
}

// Naive: strips comments (including ones inside string literals) and splits on
// every `;`. Correct for schema.sql and every migration here, all of which are
// plain DDL. A statement containing a semicolon in a string, a DELIMITER block,
// a trigger or a stored procedure will be mangled. Write those as their own
// file with a real parser, or don't write them.
// ponytail: naive splitter, swap for a real tokenizer only if a migration ever
// needs a semicolon inside a literal.
function parseSQLStatements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Every statement in schema.sql is CREATE TABLE IF NOT EXISTS, so it's safe to
// run on every boot. Further schema changes (new columns, indexes, etc.) go
// through migrations/*.sql rather than edits to schema.sql.

/** True when the database has no tables yet, i.e. schema.sql is about to
 * create everything from scratch, so no migration has anything to do. */
async function isEmptyDatabase(conn: PoolConnection): Promise<boolean> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()`,
  );
  return Number(rows[0].n) === 0;
}

async function initializeTables(conn: PoolConnection): Promise<void> {
  const schemaPath = path.join(import.meta.dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}.`);
  }

  const statements = parseSQLStatements(fs.readFileSync(schemaPath, "utf8"));
  for (const stmt of statements) {
    if (/^(USE\s|CREATE\s+DATABASE)/i.test(stmt)) continue;
    await conn.execute(stmt);
  }
  logger.info("✓ All database tables initialized successfully");
}

// For schema changes that CREATE TABLE IF NOT EXISTS can't express (new
// columns, indexes on existing tables). Each file in migrations/ runs at
// most once, tracked in _migrations, in filename order.

// MySQL commits DDL implicitly, so a migration cannot be wrapped in a real
// transaction: if the boot dies between its ALTER and the _migrations insert,
// the change is applied but unrecorded, and every later boot then aborts on
// "Duplicate column name". Statements whose error means "already there" or
// "already gone" count as done.
// ponytail: covers add/drop of columns and indexes, which is every migration
// so far. Add codes here if a future migration needs another shape.
const ALREADY_APPLIED = new Set([
  "ER_DUP_FIELDNAME", // ADD COLUMN, column exists
  "ER_DUP_KEYNAME", // ADD INDEX, index exists
  "ER_CANT_DROP_FIELD_OR_KEY", // DROP COLUMN/INDEX, already gone
]);

async function runMigrations(
  conn: PoolConnection,
  isFresh: boolean,
): Promise<void> {
  const migrationsDir = path.join(import.meta.dirname, "..", "migrations");
  if (!fs.existsSync(migrationsDir)) return;

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       VARCHAR(255) NOT NULL,
      applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  // schema.sql always describes the *current* shape, so a database created in
  // this run is already past every migration. Running them anyway fails on
  // columns that no longer exist (renames, drops) or already do (adds), so
  // stamp them as applied instead.
  if (isFresh) {
    for (const file of files)
      await conn.execute(`INSERT INTO _migrations (name) VALUES (?)`, [file]);
    logger.info(`✓ Fresh database, marked ${files.length} migrations applied`);
    return;
  }

  for (const file of files) {
    const [applied] = await conn.execute<RowDataPacket[]>(
      `SELECT 1 FROM _migrations WHERE name = ?`,
      [file],
    );
    if (applied.length > 0) continue;
    await applyMigration(conn, migrationsDir, file);
  }
}

async function applyMigration(
  conn: PoolConnection,
  migrationsDir: string,
  file: string,
): Promise<void> {
  const statements = parseSQLStatements(
    fs.readFileSync(path.join(migrationsDir, file), "utf8"),
  );
  for (const stmt of statements) {
    try {
      await conn.execute(stmt);
    } catch (err) {
      if (ALREADY_APPLIED.has((err as { code?: string }).code ?? "")) continue;
      // Without the filename the operator sees a bare MySQL error from a
      // box that won't boot, and no hint that a migration was even running.
      throw new Error(
        `migration ${file} failed on "${stmt.slice(0, 120)}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
  await conn.execute(`INSERT INTO _migrations (name) VALUES (?)`, [file]);
  logger.info(`✓ Applied migration ${file}`);
}

// How long a booting process waits for another one to finish provisioning.
const MIGRATION_LOCK_WAIT_S = 120;

/**
 * Schema provisioning and migrations, serialised across processes by a MySQL
 * advisory lock. Two processes booting against the same database at once (a
 * rolling restart, `docker compose up` racing a `docker exec owngains ...`)
 * could otherwise both see a migration as unapplied and run it twice, or both
 * decide the database is fresh. The lock is per connection, so the whole
 * sequence runs on the one connection that has it. The name includes the
 * database name so unrelated databases on one MySQL server don't queue behind
 * each other. MySQL caps lock names at 64 characters.
 */
async function provisionSchema(): Promise<void> {
  const lockName = `owngains_migrate:${requireEnv("DB_NAME")}`.slice(0, 64);
  const conn = await pool.getConnection();
  try {
    // Boot DDL on a big table can legitimately outrun the per-statement timeout
    // every pooled connection gets, and so can the GET_LOCK wait itself on
    // MariaDB, whose max_statement_time bounds every statement.
    if (queryTimeoutMs > 0) await conn.query(statementTimeoutSql(conn, 0));
    const [lock] = await conn.query<RowDataPacket[]>(
      "SELECT GET_LOCK(?, ?) AS got",
      [lockName, MIGRATION_LOCK_WAIT_S],
    );
    if (Number(lock[0]?.got) !== 1)
      throw new Error(
        `timed out after ${MIGRATION_LOCK_WAIT_S}s waiting for the migration lock "${lockName}". Is another instance stuck provisioning this database?`,
      );
    try {
      const isFresh = await isEmptyDatabase(conn);
      await initializeTables(conn);
      await runMigrations(conn, isFresh);
    } finally {
      await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
    }
  } finally {
    // Destroyed rather than released: this connection had its statement
    // timeout switched off and must not go back into the pool like that.
    conn.destroy();
  }
}

export async function testDatabaseConnection(): Promise<void> {
  try {
    await createDatabaseIfNotExists();
    const connection = await pool.getConnection();
    logger.info("✓ Database connected successfully");
    connection.release();
    await provisionSchema();
    logger.info("✓ Database is ready");
  } catch (error) {
    // Log only the message, never the error object itself, as it may contain
    // credentials from the pool config in certain mysql2 error shapes.
    logger.error(
      "✗ Database initialization failed:",
      (error as Error).message,
    );
    process.exit(1);
  }
}
