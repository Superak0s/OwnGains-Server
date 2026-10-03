// `owngains backup ...`: mysqldump-based backups of the whole database, gzipped
// and optionally encrypted with age. Shells out to mysqldump/mysql/age rather
// than dumping through mysql2: they already handle every column type, and a
// restore is then a plain `mysql < dump` an operator can also run by hand.
import { spawn } from "child_process"
import { createReadStream, createWriteStream, existsSync } from "fs"
import { chmod, mkdir, readdir, rename, stat, unlink } from "fs/promises"
import { join } from "path"
import { pipeline } from "stream/promises"
import type { Readable, Writable } from "stream"
import { createGunzip, createGzip } from "zlib"
import { envInt } from "@/config/env.js"
import { logger } from "@/utils/logger.js"

const NAME = /^owngains-\d{8}-\d{6}\.sql\.gz(\.age)?$/
// mysqldump ends every dump with this comment, and a backup contains two dumps.
const DONE_MARK = "-- Dump completed"

export const backupDir = (): string => process.env.BACKUP_DIR || "./backups"
const retentionDays = (): number => envInt("BACKUP_RETENTION_DAYS", 30, 1)

function db(): { name: string; conn: string[] } {
  const { DB_USER, DB_NAME } = process.env
  if (!DB_USER || !DB_NAME) throw new Error("DB_USER and DB_NAME must be set")
  return {
    name: DB_NAME,
    conn: ["-h", process.env.DB_HOST || "localhost", "-P", process.env.DB_PORT || "3306", "-u", DB_USER],
  }
}

/**
 * Spawns `cmd`, which may include leading words: MYSQLDUMP="docker exec -i -e
 * MYSQL_PWD <container> mysqldump" when MySQL runs in another container.
 * MYSQL_PWD keeps the password out of the process list.
 */
function run(cmd: string, args: string[], stdin: "pipe" | "ignore") {
  const [bin, ...pre] = cmd.trim().split(/\s+/)
  const child = spawn(bin!, [...pre, ...args], {
    env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD ?? "" },
    stdio: [stdin, "pipe", "inherit"],
  })
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`)),
    )
  })
  // Awaited later. Without this a spawn failure (binary missing) would be an
  // unhandled rejection before the caller gets there.
  done.catch(() => {})
  return { stdin: child.stdin as Writable, stdout: child.stdout as Readable, done }
}

const dump = (args: string[]) =>
  run(process.env.MYSQLDUMP || "mysqldump", [
    "--single-transaction", "--quick", "--no-tablespaces", "--hex-blob", ...db().conn, ...args,
  ], "ignore")

/**
 * deleted_accounts is appended as CREATE IF NOT EXISTS + INSERT IGNORE, so
 * restoring an old dump adds its tombstones to the live ones rather than
 * replacing them with the older, shorter list. The cleanup job then re-deletes
 * every restored account whose uuid is tombstoned (GDPR erasure).
 */
async function* dumpSql(): AsyncGenerator<Buffer> {
  const { name } = db()
  const main = dump([`--ignore-table=${name}.deleted_accounts`, name])
  yield* main.stdout
  await main.done
  const tombs = dump(["--skip-add-drop-table", "--insert-ignore", name, "deleted_accounts"])
  const chunks: Buffer[] = []
  for await (const c of tombs.stdout) chunks.push(c as Buffer)
  await tombs.done
  yield Buffer.from(
    Buffer.concat(chunks).toString("utf8").replace(/^CREATE TABLE /gm, "CREATE TABLE IF NOT EXISTS "),
  )
}

/** Writes a new backup into BACKUP_DIR, then prunes old ones. Returns its path. */
export async function createBackup(): Promise<string> {
  const dir = backupDir()
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o700)
  // BACKUP_AGE_RECIPIENT (an age public key, age1...) encrypts each dump, so a
  // copied or leaked file is unreadable without the private key, which should
  // not live on this box.
  const recipient = process.env.BACKUP_AGE_RECIPIENT
  if (!recipient)
    logger.warn("[BACKUP] BACKUP_AGE_RECIPIENT is unset; writing an unencrypted backup")
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  const out = join(dir, `owngains-${stamp}.sql.gz${recipient ? ".age" : ""}`)
  const part = `${out}.part`
  const file = createWriteStream(part, { mode: 0o600 })
  try {
    if (recipient) {
      const age = run(process.env.AGE || "age", ["-r", recipient], "pipe")
      await Promise.all([
        pipeline(dumpSql(), createGzip(), age.stdin),
        pipeline(age.stdout, file),
        age.done,
      ])
    } else {
      await pipeline(dumpSql(), createGzip(), file)
    }
    await rename(part, out)
  } catch (err) {
    await unlink(part).catch(() => {})
    throw err
  }
  return out
}

export interface BackupFile {
  name: string
  path: string
  bytes: number
  mtime: Date
}

/** Backups in BACKUP_DIR, newest first. */
export async function listBackups(): Promise<BackupFile[]> {
  const dir = backupDir()
  if (!existsSync(dir)) return []
  const files = await Promise.all(
    (await readdir(dir))
      .filter((n) => NAME.test(n))
      .map(async (name) => {
        const path = join(dir, name)
        const s = await stat(path)
        return { name, path, bytes: s.size, mtime: s.mtime }
      }),
  )
  return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
}

/** Deletes backups at least BACKUP_RETENTION_DAYS old. Returns the deleted names. */
export async function pruneBackups(): Promise<string[]> {
  const cutoff = Date.now() - retentionDays() * 86_400_000
  const old = (await listBackups()).filter((b) => b.mtime.getTime() <= cutoff)
  await Promise.all(old.map((b) => unlink(b.path)))
  return old.map((b) => b.name)
}

/** A path, a file name inside BACKUP_DIR, or `latest`. */
export async function resolveBackup(arg: string): Promise<string> {
  if (arg === "latest") {
    const [newest] = await listBackups()
    if (!newest) throw new Error(`No backups in ${backupDir()}`)
    return newest.path
  }
  if (existsSync(arg)) return arg
  const inDir = join(backupDir(), arg)
  if (existsSync(inDir)) return inDir
  throw new Error(`Backup not found: ${arg}`)
}

/** Streams the decrypted, decompressed SQL of `path` into `sink`. */
async function readSql(
  path: string,
  identity: string | undefined,
  sink: Writable | ((source: AsyncIterable<Buffer>) => Promise<void>),
): Promise<void> {
  if (!path.endsWith(".age")) {
    await pipeline(createReadStream(path), createGunzip(), sink as Writable)
    return
  }
  if (!identity) throw new Error("This backup is encrypted: pass --identity <age key file>")
  const age = run(process.env.AGE || "age", ["-d", "-i", identity], "pipe")
  await Promise.all([
    pipeline(createReadStream(path), age.stdin),
    pipeline(age.stdout, createGunzip(), sink as Writable),
    age.done,
  ])
}

/**
 * Decrypts and decompresses the whole file and checks both dumps in it ran to
 * completion, so a truncated or corrupt backup is found before it's needed.
 */
export async function verifyBackup(path: string, identity?: string): Promise<{ bytes: number }> {
  let bytes = 0
  let marks = 0
  let tail = ""
  await readSql(path, identity, async (source) => {
    for await (const chunk of source) {
      bytes += chunk.length
      // latin1 maps bytes 1:1, so a chunk boundary never splits a character.
      const text = tail + chunk.toString("latin1")
      marks += text.split(DONE_MARK).length - 1
      // Shorter than the mark, so a match is never counted twice.
      tail = text.slice(-(DONE_MARK.length - 1))
    }
  })
  if (marks < 2) throw new Error(`Backup is incomplete or corrupt (${marks}/2 dumps finished)`)
  return { bytes }
}

/** Replaces the contents of DB_NAME with the backup at `path`. */
export async function restoreBackup(path: string, identity?: string): Promise<void> {
  if (path.endsWith(".age") && !identity)
    throw new Error("This backup is encrypted: pass --identity <age key file>")
  const { name, conn } = db()
  const mysql = run(process.env.MYSQL || "mysql", [...conn, name], "pipe")
  await Promise.all([readSql(path, identity, mysql.stdin), mysql.done])
}
