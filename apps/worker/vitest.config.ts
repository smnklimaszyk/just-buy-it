import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    // Migrates the test template database once before the worker tests.
    globalSetup: ["./src/testing/global-setup.ts"],
    // Fails any test that calls the global fetch: eBay and Claude go through an injected fetchFn.
    setupFiles: ["./src/testing/setup.ts"],
    // Test files share the cluster-wide role lock, so they run one at a time.
    fileParallelism: false,
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
