import os from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 120_000,
    // Source operations in the coordination tests otherwise write the shared
    // clone registry into the developer's real home directory.
    env: {
      ABSORB_CLONE_REGISTRY: path.join(
        os.tmpdir(),
        `ownwork-tests-${process.pid}`,
        "clone-registry.json",
      ),
    },
  },
});
