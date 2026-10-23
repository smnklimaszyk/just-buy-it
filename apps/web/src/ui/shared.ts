import type { Child } from "hono/jsx";

export type { Child };

/** Joins class names, leaving out everything that is not a non-empty string (`error && "is-invalid"`). */
export function cx(...parts: (string | number | boolean | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ");
}

/** Type-style class names from tokens.css, as the reference names them. */
export const T = {
  caption: "type-ui-caption",
  label: "type-ui-label",
  bodySm: "type-ui-body-sm",
  body: "type-ui-body",
  bodyLg: "type-ui-body-lg",
  strong: "type-ui-strong",
  strongLg: "type-ui-strong-lg",
  titleSm: "type-title-sm",
  title: "type-title",
  titleLg: "type-title-lg",
  headlineSm: "type-headline-sm",
  code: "type-code",
  codeSm: "type-code-sm",
} as const;
