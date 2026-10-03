// PreToolUse (Edit|Write): deny edits to .env and to migrations already committed to git.
import { execFileSync } from "node:child_process";

let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const f = ((JSON.parse(s || "{}").tool_input || {}).file_path || "").replaceAll("\\", "/");
  let reason;
  if (/(^|\/)\.env$/.test(f)) {
    reason = ".env holds JWT_SECRET and DB credentials. Edit .env.example instead, and let the user change .env by hand.";
  } else if (/(^|\/)migrations\/\d+_[^/]*\.sql$/.test(f)) {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", f], { stdio: "ignore" });
      reason = `${f} is committed, and runMigrations() applies each file at most once, so an edit never reaches an existing database. Add a new migrations/NNN_description.sql instead.`;
    } catch {} // untracked: still a draft, editable
  }
  if (reason) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  }
});
