import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4311,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8790",
        changeOrigin: false
      }
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4311,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8790",
        changeOrigin: false
      }
    }
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
