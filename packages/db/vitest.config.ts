import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
