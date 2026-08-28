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
      // Byte-exact assertions against Git checkouts need the line endings that
      // were written; Windows CI turns on core.autocrlf globally.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
    },
  },
});
