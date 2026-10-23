// Guard tests for apps/web (spec 8.1 and 7.11, ADR 0039): the UI code uses the design system's
// tokens and classes only, sets no inline styles and never writes markup from strings.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_NAMES } from "./ui/icon-names.js";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");

interface Rule {
  name: string;
  /** Which files it reads: CSS, the server's TSX/TS, or the page scripts in src/client. */
  applies: (file: string) => boolean;
  pattern: RegExp;
}

const isCss = (f: string) => f.endsWith(".css");
const isCode = (f: string) => /\.tsx?$/.test(f);
const isClient = (f: string) => f.includes(`${join("src", "client")}/`);
const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

const RULES: Rule[] = [
  { name: "hex colour", applies: (f) => isCss(f) || isCode(f), pattern: /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/i },
  { name: "Tailwind palette class", applies: (f) => isCss(f) || isCode(f), pattern: new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|shadow|accent|caret|decoration)-(?:${PALETTE})-(?:50|[1-9]00|950)\\b`) },
  // px below 12, or rem/em below 0.75 (12px at the 16px root).
  { name: "font size under 12px", applies: isCss, pattern: /font-size:\s*(?:(?:\d|1[01])(?:\.\d+)?px|0?\.(?:[0-6]\d*|7[0-4]\d*|7)r?em)\b/ },
  { name: "font size class under 12px", applies: isCode, pattern: /text-\[(?:[0-9]|1[01])px\]/ },
  { name: "raw z-index", applies: isCss, pattern: /z-index:(?!\s*var\(--layer-)/ },
  { name: "transition: all", applies: isCss, pattern: /transition(?:-property)?:\s*all\b/ },
  { name: "inline style attribute", applies: isCode, pattern: /\bstyle=|setAttribute\(\s*["']style["']|\.style\.|cssText/ },
  { name: "inline <style> or <script> without src", applies: isCode, pattern: /<style[\s>]|<script(?![^>]*\bsrc=)[\s>]/ },
  { name: "raw HTML output", applies: isCode, pattern: /\braw\(|dangerouslySetInnerHTML|\bhtml`/ },
  { name: "markup from strings in a page script", applies: isClient, pattern: /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/ },
  // A bare <a> gets the browser's blue and visited purple; pages use Link (ia-link) or a design
  // system class. The components under src/ui sit inside styled parents such as .ia-crumbs.
  { name: "link without a class", applies: (f) => isCode(f) && f.includes(`${join("src", "pages")}/`), pattern: /<a\s(?![^>]*\bclass=)[^>]*>/ },
];

/** The rules a piece of text breaks, as if it were the given file. */
function broken(file: string, text: string): string[] {
  return RULES.filter((r) => r.applies(file) && r.pattern.test(text)).map((r) => r.name);
}

describe("guard rules", () => {
  it("catch each banned pattern and let the allowed forms through", () => {
    const css = join(SRC, "assets", "app.css");
    const tsx = join(SRC, "ui", "x.tsx");
    const client = join(SRC, "client", "x.ts");

    expect(broken(css, ".a { color: #1a2b3c; }")).toEqual(["hex colour"]);
    expect(broken(css, ".a { color: #fff }")).toEqual(["hex colour"]);
    expect(broken(tsx, `<a href="#main">`)).toEqual([]);
    expect(broken(tsx, '<a href={`#${id}`}>')).toEqual([]);
    expect(broken(tsx, `<p class="text-red-500">`)).toEqual(["Tailwind palette class"]);
    expect(broken(tsx, `<p class="text-fg-muted">`)).toEqual([]);
    expect(broken(css, ".a { font-size: 11px; }")).toEqual(["font size under 12px"]);
    expect(broken(css, ".a { font-size: 0.7rem; }")).toEqual(["font size under 12px"]);
    expect(broken(css, ".a { font-size: 12px; }")).toEqual([]);
    expect(broken(tsx, `<p class="text-[10px]">`)).toEqual(["font size class under 12px"]);
    expect(broken(css, ".a { z-index: 50; }")).toEqual(["raw z-index"]);
    expect(broken(css, ".a { z-index: var(--layer-toast); }")).toEqual([]);
    expect(broken(css, ".a { transition: all 200ms; }")).toEqual(["transition: all"]);
    expect(broken(css, ".a { transition: opacity var(--duration-fast) var(--ease-out); }")).toEqual([]);
    expect(broken(tsx, `<div style="width: 4px">`)).toEqual(["inline style attribute"]);
    expect(broken(tsx, `<div style={{ width: 4 }}>`)).toEqual(["inline style attribute"]);
    expect(broken(client, `el.style.width = "4px";`)).toEqual(["inline style attribute"]);
    expect(broken(tsx, `<style>a{}</style>`)).toEqual(["inline <style> or <script> without src"]);
    expect(broken(tsx, `<script>alert(1)</script>`)).toEqual(["inline <style> or <script> without src"]);
    expect(broken(tsx, `<script type="module" src={url} />`)).toEqual([]);
    expect(broken(tsx, `{raw(title)}`)).toEqual(["raw HTML output"]);
    expect(broken(tsx, `<div dangerouslySetInnerHTML={{ __html: t }} />`)).toEqual(["raw HTML output"]);
    expect(broken(tsx, "const page = html`<p>${t}</p>`;")).toEqual(["raw HTML output"]);
    expect(broken(client, `box.innerHTML = reply;`)).toEqual(["markup from strings in a page script"]);
    expect(broken(client, `p.textContent = line;`)).toEqual([]);
    expect(broken(tsx, `p.innerHTML = line;`)).toEqual([]);
    const page = join(SRC, "pages", "x.tsx");
    expect(broken(page, `<a href={url}>Cancel</a>`)).toEqual(["link without a class"]);
    expect(broken(page, `<a class="ia-link" href={url} target="_blank">`)).toEqual([]);
  });

  it("find nothing in the web app's own CSS, components, pages and page scripts", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .map((f) => join(SRC, f))
      .filter((f) => (isCss(f) || isCode(f)) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(20);

    const found = files.flatMap((f) => broken(f, readFileSync(f, "utf8")).map((rule) => `${relative(WEB, f)}: ${rule}`));
    expect(found).toEqual([]);
  });
});

describe("design-system folder", () => {
  const DS = join(WEB, "design-system");

  it("holds only what owner decision 1 allows: tokens, component CSS and typings, fonts with their OFL notice, used icons", () => {
    expect(readdirSync(DS, { recursive: true, encoding: "utf8" }).filter((f) => f.includes(".")).sort()).toEqual(
      [
        "NOTICE.md",
        "components/bundle.css",
        "components/index.d.ts",
        "fonts/Geist-Italic-Variable.woff2",
        "fonts/Geist-Variable.woff2",
        "fonts/GeistMono-Variable.woff2",
        "fonts/OFL.txt",
        "icons-LICENSE.txt",
        "icons.json",
        "tokens.css",
      ].sort(),
    );
    for (const font of ["Geist-Variable", "Geist-Italic-Variable", "GeistMono-Variable"]) {
      expect(readFileSync(join(DS, "fonts", `${font}.woff2`)).subarray(0, 4).toString()).toBe("wOF2");
    }
    const ofl = readFileSync(join(DS, "fonts", "OFL.txt"), "utf8");
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(ofl).toContain("The Geist Project Authors");
    expect(readFileSync(join(DS, "icons-LICENSE.txt"), "utf8")).toContain("ISC License");
    expect(Object.keys(JSON.parse(readFileSync(join(DS, "icons.json"), "utf8")) as object).sort()).toEqual([...ICON_NAMES].sort());
  });

  // The action and danger fills are the same in both themes by design; grounds, text, lines and
  // the status text and tints switch.
  it("has a dark value for every ground, text, line and status role, since components render the same markup in both themes", () => {
    const tokens = readFileSync(join(DS, "tokens.css"), "utf8");
    const block = (selector: string) => {
      const start = tokens.indexOf(`${selector} {`);
      return tokens.slice(start, tokens.indexOf("\n}", start));
    };
    const names = (css: string) => new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
    const light = names(block(`:root, [data-theme="light"]`));
    const dark = names(block(`[data-theme="dark"]`));
    const roles = [...light].filter((n) => /^--(?:bg|fg|border)\b|^--(?:success|warning|danger|info)-(?:fg|subtle)$/.test(n ?? ""));

    expect(roles.length).toBeGreaterThanOrEqual(20);
    expect(roles.filter((n) => !dark.has(n))).toEqual([]);
  });
});
