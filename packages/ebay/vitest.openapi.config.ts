import { defineConfig } from "vitest/config";

// Manual conformance check against the pinned Browse OpenAPI file (openapi:check). Never in CI.
export default defineConfig({
  test: {
    include: ["src/**/*.openapi.test.ts"],
  },
});
