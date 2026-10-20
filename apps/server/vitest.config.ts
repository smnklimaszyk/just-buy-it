import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
