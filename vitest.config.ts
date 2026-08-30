import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
const webProjectConfig = fileURLToPath(new URL("./apps/web/vite.config.ts", import.meta.url));

export default defineConfig({
  root: repositoryRoot,
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
            "scripts/**/*.test.ts",
            "scripts/**/*.test.mjs"
          ]
        }
      },
      webProjectConfig
    ]
  }
});
