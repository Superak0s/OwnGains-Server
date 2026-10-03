#!/usr/bin/env node
/*
  owngains.ts
  Operator CLI: list users, grant/revoke admin, reset passwords, read reports,
  suspend accounts.
  Usage (dev):
    pnpm owngains list
    pnpm owngains add <username>
    pnpm owngains remove <username>
  Usage (docker, after build):
    docker exec <container> node dist/owngains.js list
*/


import { createInterface } from "readline"
import { pathToFileURL } from "url"
import {
  createUser,
  findUserByUsername,
  setUserAdmin,
  listAdmins,
  listUsers,
  changePassword,
  setUserDisabled,
} from "./features/auth/auth.model.js"
import { listReports } from "./features/social/friends/friends.model.js"
import { passwordPolicyError, validateEmail, validateUsername } from "./middleware/validation.js"
import { readLocalOnlyFeatures } from "./config/env.js"
import {
  countHealthData,
  deleteHealthData,
  type HealthFeature,
} from "./features/tracking/healthConsent.js"
import {
  backupDir,
  createBackup,
  listBackups,
  pruneBackups,
  resolveBackup,
  restoreBackup,
  verifyBackup,
} from "./utils/backup.js"
import { logger } from "./utils/logger.js"

/** Reads one line from stdin. Not hidden: a TTY echo-off needs raw mode and a
 * hand-rolled line reader, and this runs on a box the operator already controls. */
async function promptPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await new Promise<string>((r) => rl.question("New password: ", r))).trim()
  } finally {
    rl.close()
  }
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd || cmd === "help") {
    console.log("Usage: owngains <command> [...args]")
    console.log("Commands:")
    console.log("  list                     List all users, admins first")
    console.log("  create <username> <email> [pw] [--admin]")
    console.log("                           Create an account (omit <pw> to be prompted)")
    console.log("  add <username>           Grant admin to a user")
    console.log("  remove <username>        Revoke admin from a user")
    console.log("  passwd <username> [pw]   Set a user's password (account recovery;")
    console.log("                           omit <pw> to be prompted, keeping it out of")
    console.log("                           shell history and ps)")
    console.log("  reports [limit]          List user reports filed on this instance")
    console.log("  suspend <username> <reason>  Suspend an account: it is signed out everywhere")
    console.log("                           and can't sign in until unsuspended; the reason is")
    console.log("                           shown to the user at sign-in")
    console.log("  unsuspend <username>     Lift a suspension")
    console.log("  purge-local-only [--yes] Delete every user's server copy of the features in")
    console.log("                           LOCAL_ONLY_FEATURES (dry run without --yes)")
    console.log("  backup create            Dump the database to BACKUP_DIR, then prune old backups")
    console.log("  backup list              List backups, newest first")
    console.log("  backup verify <file>     Check a backup decompresses and is complete")
    console.log("  backup restore <file> [--yes]")
    console.log("                           Replace the database with a backup (<file> may be")
    console.log("                           a name in BACKUP_DIR or `latest`). Encrypted backups")
    console.log("                           need --identity <age key file>")
    console.log("  backup prune             Delete backups older than BACKUP_RETENTION_DAYS")
    return 0
  }

  try {
    if (cmd === "list") {
      const users = await listUsers()
      if (!users.length) {
        console.log("No users found")
        return 0
      }
      console.log(`${users.length} user(s), admins first:`)
      for (const u of users) {
        console.log(
          `- ${u.isAdmin ? "[admin]" : u.disabled ? "[susp.]" : "       "} id=${u.id} uuid=${u.uuid} username=${u.username} email=${u.email} name=${u.name} createdAt=${u.createdAt.toString()}`,
        )
      }
      return 0
    }

    if (cmd === "create") {
      const admin = args.includes("--admin")
      const [username, email, pw] = args.slice(1).filter((a) => a !== "--admin")
      if (!username || !email) {
        console.error("Usage: owngains create <username> <email> [password] [--admin]")
        return 2
      }
      if (!validateUsername(username)) {
        console.error("Username must be 3-20 characters (letters, numbers, underscores)")
        return 2
      }
      if (!validateEmail(email)) {
        console.error("Invalid email format")
        return 2
      }
      const password = pw ?? (await promptPassword())
      const policyError = passwordPolicyError(password)
      if (policyError) {
        console.error(policyError)
        return 2
      }
      const id = await createUser(username, email, password)
      if (admin) await setUserAdmin(id, true)
      console.log(`Created ${username}${admin ? " (admin)" : ""}.`)
      return 0
    }

    if (cmd === "add" || cmd === "remove") {
      const username = args[1]
      if (!username) {
        console.error("Username required")
        return 2
      }
      const user = await findUserByUsername(username)
      if (!user) {
        console.error(`User not found: ${username}`)
        return 2
      }
      // Demoting the only admin locks the box out of every admin action, and
      // this CLI is the only way back in, so it has to be refused here.
      if (cmd === "remove") {
        const admins = await listAdmins()
        if (admins.length <= 1 && admins[0]?.id === user.id) {
          console.error(
            `Refusing to remove the only admin (${username}). Grant admin to someone else first.`,
          )
          return 2
        }
      }
      const ok = await setUserAdmin(user.id, cmd === "add")
      if (!ok) {
        console.error("Failed to update user admin status")
        return 1
      }
      logger.warn(`[AUDIT] cli admin ${cmd}`, { target: user.uuid })
      console.log(`User ${username} admin=${cmd === "add"}`)
      return 0
    }

    if (cmd === "passwd") {
      const [username] = args.slice(1)
      if (!username) {
        console.error("Usage: owngains passwd <username> [newpassword]")
        return 2
      }
      // argv remains the scriptable path, but a password given there ends up in
      // ~/.bash_history and in `ps aux` for the life of the command. Prompt
      // when it's omitted.
      const newPassword = args[2] ?? (await promptPassword())
      if (!newPassword) {
        console.error("No password entered")
        return 2
      }
      const policyError = passwordPolicyError(newPassword)
      if (policyError) {
        console.error(policyError)
        return 2
      }
      const user = await findUserByUsername(username)
      if (!user) {
        console.error(`User not found: ${username}`)
        return 2
      }
      // changePassword bumps token_version, so every device signed in as this
      // user is signed out, which is what you want after a recovery reset.
      await changePassword(user.id, newPassword)
      logger.warn("[AUDIT] cli passwd", { target: user.uuid })
      console.log(`Password reset for ${username}. All existing sessions were signed out.`)
      return 0
    }

    if (cmd === "reports") {
      // parseInt("-5") is -5, not NaN, and reached `LIMIT -5` as a raw MySQL
      // syntax error. Clamped the same way queryLimit clamps the HTTP routes.
      const parsed = parseInt(args[1] ?? "100", 10)
      const limit = Math.min(Math.max(Number.isNaN(parsed) ? 100 : parsed, 1), 1000)
      const reports = await listReports(limit)
      if (!reports.length) {
        console.log("No reports filed")
        return 0
      }
      console.log(`${reports.length} report(s), newest first:`)
      for (const r of reports) {
        const reported = `${r.reported_username ?? "[unknown]"}${
          !r.reported_exists ? " [deleted]" : r.reported_disabled ? " [suspended]" : ""
        }`
        console.log(
          `- #${r.id} ${r.created_at} ${r.reporter_username ?? "[deleted user]"} reported ${reported} (${r.reason})`,
        )
        if (r.details) console.log(`    ${r.details}`)
      }
      return 0
    }

    if (cmd === "suspend" || cmd === "unsuspend") {
      const username = args[1]
      if (!username) {
        console.error(`Usage: owngains ${cmd} <username>${cmd === "suspend" ? " <reason>" : ""}`)
        return 2
      }
      const user = await findUserByUsername(username)
      if (!user) {
        console.error(`User not found: ${username}`)
        return 2
      }
      if (cmd === "suspend" && user.isAdmin) {
        console.error(`Refusing to suspend an admin (${username}). Run \`owngains remove ${username}\` first.`)
        return 2
      }
      const reason = args.slice(2).join(" ").trim()
      if (cmd === "suspend" && (!reason || reason.length > 500)) {
        console.error("Usage: owngains suspend <username> <reason> (shown to the user, max 500 chars)")
        return 2
      }
      await setUserDisabled(user.id, cmd === "suspend", reason || null)
      logger.warn(`[AUDIT] cli ${cmd}`, { target: user.uuid })
      console.log(
        cmd === "suspend"
          ? `User ${username} suspended and signed out everywhere.`
          : `User ${username} unsuspended.`,
      )
      return 0
    }

    if (cmd === "purge-local-only") {
      const features = readLocalOnlyFeatures() as HealthFeature[]
      if (!features.length) {
        console.error("LOCAL_ONLY_FEATURES is empty: this server keeps no feature on-device, so there is nothing to purge.")
        return 2
      }
      const yes = args.includes("--yes")
      const counts = yes
        ? await deleteHealthData(null, features)
        : await countHealthData(features)
      for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`)
      if (yes) logger.warn("[AUDIT] cli purge-local-only", { features, counts })
      console.log(
        yes
          ? `Deleted the server copy of: ${features.join(", ")}.`
          : `Dry run. Re-run with --yes to delete these rows for EVERY user (${features.join(", ")}).`,
      )
      return 0
    }

    if (cmd === "backup") {
      const sub = args[1]
      const at = args.indexOf("--identity")
      const identity = at > 0 ? args[at + 1] : undefined
      const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

      if (sub === "create") {
        const out = await createBackup()
        const pruned = await pruneBackups()
        console.log(`Wrote ${out}${pruned.length ? `; pruned ${pruned.join(", ")}` : ""}`)
        return 0
      }
      if (sub === "list") {
        const backups = await listBackups()
        if (!backups.length) console.log(`No backups in ${backupDir()}`)
        for (const b of backups)
          console.log(`- ${b.name}  ${mb(b.bytes)}  ${b.mtime.toISOString()}`)
        return 0
      }
      if (sub === "prune") {
        const pruned = await pruneBackups()
        console.log(pruned.length ? `Deleted ${pruned.join(", ")}` : "Nothing to prune")
        return 0
      }
      if ((sub === "verify" || sub === "restore") && args[2] && args[2] !== "--identity") {
        const path = await resolveBackup(args[2])
        if (sub === "verify") {
          const { bytes } = await verifyBackup(path, identity)
          console.log(`${path} is complete (${mb(bytes)} of SQL)`)
          return 0
        }
        if (!args.includes("--yes")) {
          console.log(
            `This replaces every table in ${process.env.DB_NAME} with ${path}. ` +
              "Stop the server first, then re-run with --yes.",
          )
          return 2
        }
        await restoreBackup(path, identity)
        logger.warn("[AUDIT] cli backup restore", { path })
        console.log(`Restored ${path}. Accounts deleted since it was taken are erased again on the next cleanup run.`)
        return 0
      }
      console.error("Usage: owngains backup create|list|prune|verify <file>|restore <file> [--yes] [--identity <key>]")
      return 2
    }

    console.error("Unknown command")
    return 2
  } catch (err) {
    console.error("Error:", (err as Error).message)
    return 1
  }
}

// Only run when launched directly, so tests can import main() without side
// effects. pathToFileURL makes relative launch scripts compare equal.
const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) void main().then((code) => process.exit(code))
