#!/usr/bin/env node
// Replaces CHANGELOG.md with an empty Keep a Changelog template, discarding every entry.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const TEMPLATE = `# Changelog

All notable changes to this project are recorded here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

Add an entry under **Unreleased** in the same change that introduces it. At release time that section is renamed to the new version and date.

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

### Internal

[Unreleased]: https://github.com/Superak0s/OwnGains-Server/commits/HEAD`;

fs.writeFileSync(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)), TEMPLATE + "\n");
console.log("CHANGELOG.md reset to the empty template");
