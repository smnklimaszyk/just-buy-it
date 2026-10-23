import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    // The files share one cluster-wide role lock, and migrate.test.ts holds it for 10 s on purpose,
    // so files running side by side can time out waiting for it. Run them one at a time.
    fileParallelism: false,
    // Whole values in failure messages, so a failed table or row list shows what is missing.
    chaiConfig: { truncateThreshold: 0 },
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
