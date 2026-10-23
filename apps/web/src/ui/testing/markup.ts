// Compares two pieces of rendered markup as trees, so attribute order, the way an entity is
// written and `<path/>` versus `<path></path>` do not count as differences.

export interface MarkupElement {
  tag: string;
  attrs: Map<string, string>;
  children: MarkupNode[];
}
export type MarkupNode = MarkupElement | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TOKEN = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseMarkup(html: string): MarkupNode[] {
  const root: MarkupElement = { tag: "#root", attrs: new Map(), children: [] };
  const stack: MarkupElement[] = [root];
  for (const match of html.matchAll(TOKEN)) {
    const [, closing, opening, attrText, selfClosing, text] = match;
    const parent = stack[stack.length - 1] ?? root;
    if (text !== undefined) {
      parent.children.push(decode(text));
    } else if (closing !== undefined) {
      if (stack.length > 1 && parent.tag === closing) stack.pop();
      else throw new Error(`unexpected </${closing}> inside <${parent.tag}>`);
    } else if (opening !== undefined) {
      const attrs = new Map<string, string>();
      for (const a of (attrText ?? "").matchAll(ATTR)) {
        const [, name, dq, sq, bare] = a;
        if (name) attrs.set(name.toLowerCase(), decode(dq ?? sq ?? bare ?? ""));
      }
      const element: MarkupElement = { tag: opening, attrs, children: [] };
      parent.children.push(element);
      if (!selfClosing && !VOID.has(opening)) stack.push(element);
    }
  }
  if (stack.length > 1) throw new Error(`<${stack[stack.length - 1]?.tag}> is not closed`);
  return root.children;
}

// Attributes a server-rendered form needs and the React reference leaves to its state:
// form field names and values, validation, and data-* hooks for the page scripts.
const PORT_ONLY = new Set([
  "name",
  "value",
  "required",
  "autocomplete",
  "inputmode",
  "pattern",
  "minlength",
  "maxlength",
  "form",
  "method",
  "action",
]);

function portOnly(name: string): boolean {
  return PORT_ONLY.has(name) || name.startsWith("data-");
}

function describeNode(node: MarkupNode | undefined): string {
  if (node === undefined) return "nothing";
  return typeof node === "string" ? JSON.stringify(node) : `<${node.tag}>`;
}

function compare(ours: MarkupNode[], reference: MarkupNode[], path: string, out: string[]): void {
  const length = Math.max(ours.length, reference.length);
  for (let i = 0; i < length; i++) {
    const a = ours[i];
    const b = reference[i];
    const here = `${path}/${i}`;
    if (typeof a === "string" || typeof b === "string" || a === undefined || b === undefined) {
      if (a !== b) out.push(`${here}: ${describeNode(a)} instead of ${describeNode(b)}`);
      continue;
    }
    if (a.tag !== b.tag) {
      out.push(`${here}: <${a.tag}> instead of <${b.tag}>`);
      continue;
    }
    const names = new Set([...a.attrs.keys(), ...b.attrs.keys()]);
    for (const name of [...names].sort()) {
      const va = a.attrs.get(name);
      // The reference sets sizes and fills inline; the port's CSP has no inline styles (ADR 0039).
      const vb = name === "style" ? undefined : b.attrs.get(name);
      if (vb === undefined && va !== undefined && portOnly(name)) continue;
      if (va !== vb) out.push(`${here} <${a.tag}> ${name}: ${JSON.stringify(va)} instead of ${JSON.stringify(vb)}`);
    }
    compare(a.children, b.children, `${here} <${a.tag}>`, out);
  }
}

// Attributes whose value is an id (or a list of ids). The reference makes them with React's
// useId, the port takes them from props, so both are renamed id1, id2, ... in document order.
const ID_ATTRS = ["id", "for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-activedescendant"];

function renameIds(nodes: MarkupNode[], names: Map<string, string>): void {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    for (const attr of ID_ATTRS) {
      const value = node.attrs.get(attr);
      if (value === undefined) continue;
      const renamed = value.split(/\s+/).map((id) => {
        const known = names.get(id);
        if (known) return known;
        const next = `id${names.size + 1}`;
        names.set(id, next);
        return next;
      });
      node.attrs.set(attr, renamed.join(" "));
    }
    renameIds(node.children, names);
  }
}

function prepare(html: string): MarkupNode[] {
  const nodes = parseMarkup(html);
  renameIds(nodes, new Map());
  return nodes;
}

export function diffMarkup(ours: string, reference: string): string[] {
  const out: string[] = [];
  compare(prepare(ours), prepare(reference), "", out);
  return out;
}
