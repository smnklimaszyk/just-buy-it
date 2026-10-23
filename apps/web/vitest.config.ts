import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "hono/jsx" } },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    // Migrates the template database the sign-in and page tests copy.
    globalSetup: ["./src/testing/global-setup.ts"],
    // The database test files share the cluster-wide role lock, so they run one at a time.
    fileParallelism: false,
    // Whole values in failure messages, such as the full route list.
    chaiConfig: { truncateThreshold: 0 },
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
