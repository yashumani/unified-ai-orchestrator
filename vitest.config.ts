import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "services/**/*.test.ts",
      "scripts/**/*.test.mjs"
    ]
  }
});
