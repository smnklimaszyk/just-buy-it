import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAssets } from "./build-assets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "web-assets-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

/** The file behind an /assets URL, after checking that its name carries its content's hash. */
function hashedFile(url: string): string {
  const [, name, hash, ext] = /^\/assets\/([\w-]+)\.([0-9a-f]{12})\.(css|js|woff2)$/.exec(url) ?? [];
  if (!name || !hash || !ext) throw new Error(`not a hashed asset URL: ${url}`);
  const file = join(out, `${name}.${hash}.${ext}`);
  expect(createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12)).toBe(hash);
  return file;
}

describe("buildAssets", () => {
  it("writes the styles under a name that carries the hash of their content", () => {
    const manifest = buildAssets({ root: ROOT, outDir: out });

    expect(manifest.styles).toMatch(/^\/assets\/styles\.[0-9a-f]{12}\.css$/);
    hashedFile(manifest.styles);
  });

  it("writes the three fonts hashed and points the stylesheet's @font-face rules at them", () => {
    const manifest = buildAssets({ root: ROOT, outDir: out });
    const css = readFileSync(hashedFile(manifest.styles), "utf8");

    for (const [key, file] of [
      ["geist", "Geist-Variable"],
      ["geistItalic", "Geist-Italic-Variable"],
      ["geistMono", "GeistMono-Variable"],
    ] as const) {
      const url = manifest.fonts[key];
      expect(url).toMatch(new RegExp(`^/assets/${file}\\.[0-9a-f]{12}\\.woff2$`));
      expect(readFileSync(hashedFile(url)).subarray(0, 4).toString()).toBe("wOF2");
      expect(css).toContain(`url("${url}")`);
    }
    expect(css).not.toMatch(/url\("fonts\//);
  });

  it("compiles each page script to a JavaScript module that loads without a DOM", async () => {
    const manifest = buildAssets({ root: ROOT, outDir: out });

    for (const [name, url] of Object.entries(manifest.scripts)) {
      expect(url).toMatch(new RegExp(`^/assets/${name}\\.[0-9a-f]{12}\\.js$`));
      const file = hashedFile(url);
      expect(readFileSync(file, "utf8")).not.toMatch(/: (string|number|boolean|void)\b|\binterface\b/);
      await import(pathToFileURL(file).href);
    }
    const tags = (await import(pathToFileURL(hashedFile(manifest.scripts.tags)).href)) as { splitTags: (t: string) => string[] };
    expect(tags.splitTags("a, b")).toEqual(["a", "b"]);
  });

  it("writes manifest.json, gives the same names on a rebuild and leaves no file of an older build", () => {
    writeFileSync(join(out, "styles.000000000000.css"), "old");

    const first = buildAssets({ root: ROOT, outDir: out });
    const second = buildAssets({ root: ROOT, outDir: out });

    expect(second).toEqual(first);
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toEqual(first);
    const names = [first.styles, ...Object.values(first.fonts), ...Object.values(first.scripts)].map((u) => u.slice("/assets/".length));
    expect(readdirSync(out).sort()).toEqual([...names, "manifest.json"].sort());
  });

  it("runs as the build step: node scripts/build-assets.ts <out folder>", () => {
    execFileSync(process.execPath, [join(ROOT, "scripts", "build-assets.ts"), out], { stdio: "pipe" });

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { styles: string };
    hashedFile(manifest.styles);
  });
});
