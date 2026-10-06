#!/usr/bin/env bun
// CHANGELOG.md helpers for scripts/release.sh.
//
//   bun scripts/changelog.mjs check <version>          exit 0 if [Unreleased] has entries,
//                                                        2 if it is empty, 1 on error
//   bun scripts/changelog.mjs stamp <version> <date>   rename [Unreleased] to [<version>] - <date>,
//                                                        add a fresh [Unreleased] and fix the links
//   bun scripts/changelog.mjs notes <version> <file>   write that version's section to <file>;
//                                                        exit 2 if it is missing or empty
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
const REPO_URL = "https://github.com/Superak0s/OwnGains-Server";
const tag = (version) => `v${version}`;

const [cmd, version, arg] = process.argv.slice(2);

function fail(msg, code = 1) {
  console.error(`changelog: ${msg}`);
  process.exit(code);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isHeading = (line) => /^## /.test(line);
const isLinkRef = (line) => /^\[[^\]]+\]:\s/.test(line);

// Index of the "## [name]" heading and the line after its section ends (the
// next "## " heading or the link references at the bottom).
function findSection(lines, name) {
  const start = lines.findIndex((l) => new RegExp(`^## \\[${escape(name)}\\]`).test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end]) && !isLinkRef(lines[end])) end++;
  return { start, end };
}

// A section has entries when anything but blank lines and "###" headings is in it.
const hasEntries = (body) => body.some((l) => l.trim() !== "" && !/^###\s/.test(l));

// Drop "###" headings with nothing under them, and collapse runs of blank lines.
function tidy(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (/^###\s/.test(body[i])) {
      let j = i + 1;
      while (j < body.length && body[j].trim() === "") j++;
      if (j >= body.length || /^###\s/.test(body[j])) continue;
    }
    if (body[i].trim() === "" && out.length && out[out.length - 1].trim() === "") continue;
    out.push(body[i]);
  }
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

if (!["check", "stamp", "notes"].includes(cmd) || !version) {
  fail("usage: changelog.mjs check|stamp|notes <version> [date|file]");
}
if (!fs.existsSync(FILE)) fail(`${FILE} not found`);

const text = fs.readFileSync(FILE, "utf8");
const eol = text.includes("\r\n") ? "\r\n" : "\n";
const lines = text.split(/\r?\n/);

if (cmd === "check") {
  if (findSection(lines, version)) fail(`CHANGELOG.md already has a [${version}] section`);
  const unreleased = findSection(lines, "Unreleased");
  if (!unreleased) fail("CHANGELOG.md has no ## [Unreleased] section");
  process.exit(hasEntries(lines.slice(unreleased.start + 1, unreleased.end)) ? 0 : 2);
}

if (cmd === "stamp") {
  const date = arg;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) fail("stamp needs a YYYY-MM-DD date");
  if (findSection(lines, version)) fail(`CHANGELOG.md already has a [${version}] section`);
  const unreleased = findSection(lines, "Unreleased");
  if (!unreleased) fail("CHANGELOG.md has no ## [Unreleased] section");

  const body = tidy(lines.slice(unreleased.start + 1, unreleased.end));
  const rest = lines.slice(unreleased.end);
  const out = [
    ...lines.slice(0, unreleased.start),
    "## [Unreleased]",
    "",
    `## [${version}] - ${date}`,
    "",
    ...body,
    "",
    ...rest,
  ];

  // Point [Unreleased] at the new tag and add a link for the new version.
  const newLinks = [
    `[Unreleased]: ${REPO_URL}/compare/${tag(version)}...HEAD`,
    `[${version}]: ${REPO_URL}/releases/tag/${tag(version)}`,
  ];
  const linkIdx = out.findIndex((l) => /^\[Unreleased\]:\s/.test(l));
  if (linkIdx === -1) {
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push("", ...newLinks);
  } else {
    out.splice(linkIdx, 1, ...newLinks);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();

  fs.writeFileSync(FILE, out.join(eol) + eol);
  console.log(`CHANGELOG.md: [Unreleased] is now [${version}] - ${date}`);
  process.exit(0);
}

if (cmd === "notes") {
  if (!arg) fail("notes needs an output file");
  const section = findSection(lines, version);
  if (!section) fail(`no [${version}] section in CHANGELOG.md`, 2);
  const body = tidy(lines.slice(section.start + 1, section.end));
  if (!hasEntries(body)) fail(`the [${version}] section is empty`, 2);
  fs.writeFileSync(arg, body.join("\n") + "\n");
  process.exit(0);
}
