import js from "@eslint/js";
import tseslint from "typescript-eslint";

// ADR 0008: the system clock is read only in apps/*/src/clock.ts.
const CLOCK_READS = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "read the time through the injected clock (ADR 0008)",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "read the time through the injected clock (ADR 0008)",
  },
];

// ADR 0006: apps read env only through loadEnv() in src/env.ts.
const ENV_READS = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: "read env only in src/env.ts",
  },
];

const TESTS = ["**/*.test.ts"];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly", __dirname: "readonly" },
    },
  },
  // A later config object replaces the options of no-restricted-syntax instead of merging them,
  // so each glob below lists every selector that applies to it.
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: TESTS,
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS],
      "no-restricted-globals": ["error", { name: "process", message: "packages do not read process (ADR 0006)" }],
    },
  },
  {
    files: ["apps/*/src/**/*.ts"],
    ignores: ["apps/*/src/clock.ts", "apps/*/src/env.ts", ...TESTS],
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS, ...ENV_READS],
    },
  },
  {
    files: ["apps/*/src/env.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS],
    },
  },
  {
    files: ["apps/*/src/clock.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...ENV_READS],
    },
  },
);
