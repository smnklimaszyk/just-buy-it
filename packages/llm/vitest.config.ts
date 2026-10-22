import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    // The eval set calls the real Claude API and runs only by hand (vitest.eval.config.ts).
    exclude: [...configDefaults.exclude, "evals/**"],
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
