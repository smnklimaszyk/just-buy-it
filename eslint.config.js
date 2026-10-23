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

// ADR 0007: only packages/llm talks to Anthropic, so the API host appears nowhere else.
const ANTHROPIC_HOST = [
  {
    selector: "Literal[value=/api\\.anthropic\\.com/]",
    message: "only packages/llm calls the Anthropic API (ADR 0007)",
  },
  {
    selector: "TemplateElement[value.raw=/api\\.anthropic\\.com/]",
    message: "only packages/llm calls the Anthropic API (ADR 0007)",
  },
];

const TESTS = ["**/*.test.ts", "**/*.test.tsx"];

export default tseslint.config(
  // The vendored design system (ADR 0039) is kept as delivered.
  { ignores: ["**/dist/**", "**/node_modules/**", "apps/web/design-system/**"] },
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
  // so each glob below lists every selector that applies to it. This first one covers every file
  // the later ones do not, tests and tools included.
  {
    files: ["**/*.{ts,tsx,js,cjs,mjs}"],
    ignores: ["packages/llm/**"],
    rules: {
      "no-restricted-syntax": ["error", ...ANTHROPIC_HOST],
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["packages/llm/**", ...TESTS],
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS, ...ANTHROPIC_HOST],
      "no-restricted-globals": ["error", { name: "process", message: "packages do not read process (ADR 0006)" }],
    },
  },
  {
    files: ["packages/llm/src/**/*.ts"],
    ignores: TESTS,
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS],
      "no-restricted-globals": ["error", { name: "process", message: "packages do not read process (ADR 0006)" }],
    },
  },
  {
    files: ["apps/*/src/**/*.{ts,tsx}"],
    ignores: ["apps/*/src/clock.ts", "apps/*/src/env.ts", ...TESTS],
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS, ...ENV_READS, ...ANTHROPIC_HOST],
    },
  },
  {
    files: ["apps/*/src/env.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS, ...ANTHROPIC_HOST],
    },
  },
  {
    files: ["apps/*/src/clock.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...ENV_READS, ...ANTHROPIC_HOST],
    },
  },
);
