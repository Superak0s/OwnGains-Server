// Copies the non-TS runtime files into dist/. A script rather than a cp line because Bun's shell cp has no -r on Windows.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/config", { recursive: true });
cpSync("src/config/schema.sql", "dist/config/schema.sql");
cpSync("src/features/workouts/demo-photos", "dist/features/workouts/demo-photos", { recursive: true });
cpSync("src/migrations", "dist/migrations", { recursive: true });
