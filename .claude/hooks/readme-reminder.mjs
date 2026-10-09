// PostToolUse (Edit|Write): after a change to a feature's routes, the router mounts, env config or
// the schema, remind Claude to bring README.md in line (API, Configuration and Data model sections).
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const f = ((JSON.parse(s || "{}").tool_input || {}).file_path || "").replaceAll("\\", "/");
  if (/\/__tests__\/|\.test\.ts$/.test(f)) return;
  if (!/\/src\/(features\/.*\.(routes|model)\.ts|routes\.ts|config\/(env\.ts|schema\.sql)|ws\/wsServer\.ts|jobs\/[^/]+\.ts)$/.test(f)) return;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `${f} changed. Before finishing, check whether README.md still matches it (routes under API, env variables under Configuration, tables under Data model, WS events, background jobs) and update it in the same turn if not. Skip if the change is internal only.`,
    },
  }));
});
