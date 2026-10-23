import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    // Whole values in failure messages: the expected docker call lists are long.
    chaiConfig: { truncateThreshold: 0 },
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
