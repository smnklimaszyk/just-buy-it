import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

// Manual eval run against the real Claude API: pnpm --filter @ebay-sniper/llm eval.
// No CI job runs it; without ANTHROPIC_API_KEY every case is skipped.
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts", "evals/**/*.test.ts"],
    // One case is one Claude call with a 60 s timeout.
    testTimeout: 120_000,
    fileParallelism: false,
    reporters: ["default", ["tdd-guard-vitest", { projectRoot }]],
  },
});
