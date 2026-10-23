// Renders the shared component cases (apps/web/src/ui/testing/reference-cases.ts) with the
// design system's own React components, so the port's tests can compare against real markup.
import { runInNewContext } from "node:vm";

export interface ReactLike {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

export interface CaseElement {
  readonly $c: string;
  readonly p?: Readonly<Record<string, unknown>>;
  readonly children?: readonly unknown[];
}

export interface ReferenceCase {
  readonly id: string;
  readonly node: CaseElement;
}

export interface Renderer {
  components: Readonly<Record<string, unknown>>;
  React: ReactLike;
  render: (element: unknown) => string;
}

// components/bundle.js is a classic script that reads window.React and fills window.Intra.
export function loadReferenceComponents(bundleSource: string, React: ReactLike): Record<string, unknown> {
  const window: { React: ReactLike; Intra?: Record<string, unknown> } = { React };
  runInNewContext(bundleSource, { window }, { filename: "bundle.js" });
  if (!window.Intra) throw new Error("bundle.js did not define window.Intra");
  return window.Intra;
}

function isCaseElement(value: unknown): value is CaseElement {
  return typeof value === "object" && value !== null && "$c" in value;
}

function toReact(value: unknown, renderer: Renderer, id: string): unknown {
  if (Array.isArray(value)) return value.map((v) => toReact(v, renderer, id));
  if (isCaseElement(value)) {
    const component = renderer.components[value.$c];
    if (component === undefined) throw new Error(`case ${id} uses ${value.$c}, which the design system does not have`);
    const props: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value.p ?? {})) props[key] = toReact(v, renderer, id);
    const children = (value.children ?? []).map((c) => toReact(c, renderer, id));
    return renderer.React.createElement(component, props, ...children);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toReact(v, renderer, id)]));
  }
  return value;
}

export function renderReferenceCases(cases: readonly ReferenceCase[], renderer: Renderer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of cases) out[c.id] = renderer.render(toReact(c.node, renderer, c.id));
  return out;
}
