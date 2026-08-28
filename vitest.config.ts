import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    projects: [
      {
        extends: false,
        test: {
          name: "node",
          environment: "node",
          pool: "threads",
          maxWorkers: 1,
          fileParallelism: false,
          include: [
            "apps/api/**/*.test.ts",
            "packages/**/*.test.ts",
            "services/**/*.test.ts",
            "scripts/**/*.test.mjs"
          ]
        }
      },
      "./apps/web/vite.config.ts"
    ]
  }
});
