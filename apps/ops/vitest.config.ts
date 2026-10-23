import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    // The database test files each create and migrate their own database and share the
    // cluster-wide role lock, so they run one at a time, as in packages/db.
    fileParallelism: false,
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
