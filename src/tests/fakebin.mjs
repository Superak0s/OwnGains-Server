// Stand-in for mysqldump, mysql and age in the backup tests, picked by the
// first argument: `bun fakebin.mjs dump|mysql|age ...`.
import { appendFileSync } from "node:fs"

const [mode, ...args] = process.argv.slice(2)
if (process.env[`FAKE_${mode.toUpperCase()}_FAIL`]) process.exit(3)

if (mode === "dump") {
  const table = args.at(-1) === "deleted_accounts" ? "deleted_accounts" : "users"
  process.stdout.write(`CREATE TABLE \`${table}\` (id int);\n-- Dump completed\n`)
} else {
  // age encrypts and decrypts as a pass-through, mysql records what it was fed.
  for await (const chunk of process.stdin) {
    if (mode === "age") process.stdout.write(chunk)
    else appendFileSync(process.env.FAKE_MYSQL_OUT, chunk)
  }
}
