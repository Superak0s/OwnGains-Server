// Copies the non-TS runtime files into dist/. Plain Node so `bun run build` works on Windows too (Bun's shell cp has no -r).
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/config", { recursive: true });
cpSync("src/config/schema.sql", "dist/config/schema.sql");
cpSync("src/features/workouts/demo-photos", "dist/features/workouts/demo-photos", { recursive: true });
cpSync("src/migrations", "dist/migrations", { recursive: true });
