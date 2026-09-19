import { defineConfig } from "vitest/config";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    fileParallelism: false,
    // PAYMENT P0 (M3) — database-binding + no-real-HTTP guards.
    setupFiles: ["src/test-support/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
