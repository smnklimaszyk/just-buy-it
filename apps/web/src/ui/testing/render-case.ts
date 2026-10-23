import { jsx, type Child } from "hono/jsx";
import * as ui from "../index.js";
import type { CaseElement, CaseValue } from "./reference-cases.js";

type Component = (props: Record<string, unknown>) => unknown;

function isCaseElement(value: CaseValue): value is CaseElement {
  return typeof value === "object" && "$c" in value;
}

function toJsx(value: CaseValue): unknown {
  if (Array.isArray(value)) return value.map(toJsx);
  if (typeof value !== "object") return value;
  if (isCaseElement(value)) {
    const component = (ui as Record<string, unknown>)[value.$c];
    if (typeof component !== "function") throw new Error(`the port has no component ${value.$c}`);
    const props: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value.p ?? {})) props[key] = toJsx(v);
    return jsx(component as Component, props, ...((value.children ?? []).map(toJsx) as Child[]));
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsx(v)]));
}

/** The case as a JSX node of the port's components. */
export function caseToJsx(node: CaseElement): Child {
  return toJsx(node) as Child;
}

export function renderCase(node: CaseElement): string {
  return String(toJsx(node));
}
