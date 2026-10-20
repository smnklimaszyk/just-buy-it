import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.openapi.test.ts"],
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
