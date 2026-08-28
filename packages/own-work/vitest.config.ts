import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 120_000,
  },
});
