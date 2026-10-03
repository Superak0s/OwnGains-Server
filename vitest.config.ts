import { defineConfig } from "vitest/config"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: { "@": path.join(root, "src") },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/tests/setup-env.ts"],
    globalSetup: ["./src/tests/global-setup.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    exclude: ["**/node_modules/**", "dist/**", ".claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "src/tests/**",
        "**/*.test.ts",
        "**/*.d.ts",
        "src/middleware/validation.check.ts",
      ],
    },
  },
})
