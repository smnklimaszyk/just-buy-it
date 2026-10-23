import { describe, expect, it } from "vitest";
import { loadReferenceComponents, renderReferenceCases, type ReactLike } from "./reference.ts";

interface FakeElement {
  type: unknown;
  props: Record<string, unknown>;
}

// Enough of React for the test: elements are plain objects and the renderer calls function
// components and prints intrinsic tags with their className and children.
const React: ReactLike = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
};

function render(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(render).join("");
  const element = node as FakeElement;
  if (typeof element.type === "function") return render((element.type as (p: unknown) => unknown)(element.props));
  const className = element.props["className"];
  return `<${String(element.type)}${className ? ` class="${String(className)}"` : ""}>${render(element.props["children"])}</${String(element.type)}>`;
}

const components = {
  Badge: (p: { tone: string; children: unknown }) => React.createElement("span", { className: `ia-badge--${p.tone}` }, p.children),
  PageHeader: (p: { title: string; actions: unknown }) => React.createElement("header", null, p.title, p.actions),
};

describe("loadReferenceComponents", () => {
  it("runs the classic-script bundle against the given React and returns window.Intra", () => {
    const bundle = `(function(){ var R = window.React; window.Intra = Object.assign(window.Intra || {}, { Kbd: function (p) { return R.createElement("kbd", { className: "ia-kbd" }, p.children); } }); })();`;

    const loaded = loadReferenceComponents(bundle, React);

    expect(render(React.createElement(loaded["Kbd"], null, "Esc"))).toBe(`<kbd class="ia-kbd">Esc</kbd>`);
  });
});

describe("renderReferenceCases", () => {
  it("renders each case with the reference components, turning nested case elements into elements", () => {
    const html = renderReferenceCases(
      [
        { id: "badge", node: { $c: "Badge", p: { tone: "info" }, children: ["Draft"] } },
        { id: "header", node: { $c: "PageHeader", p: { title: "Products", actions: { $c: "Badge", p: { tone: "success" }, children: ["Active"] } } } },
      ],
      { components, React, render },
    );

    expect(html).toEqual({
      badge: `<span class="ia-badge--info">Draft</span>`,
      header: `<header>Products<span class="ia-badge--success">Active</span></header>`,
    });
  });

  it("refuses a case that names a component the design system does not have", () => {
    expect(() => renderReferenceCases([{ id: "x", node: { $c: "Carousel" } }], { components, React, render })).toThrow(
      "case x uses Carousel, which the design system does not have",
    );
  });
});
