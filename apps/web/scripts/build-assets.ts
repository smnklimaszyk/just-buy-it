// Builds dist/assets: the styles, the fonts and the page scripts under content-hashed names,
// and dist/assets/manifest.json with those names (ui/assets.ts AssetManifest).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CLIENT_SCRIPTS, type AssetManifest, type ClientScript } from "../src/ui/assets.ts";

export interface BuildOptions {
  /** apps/web */
  root: string;
  outDir: string;
}

/** Writes the content as <name>.<first 12 hex of its sha256>.<ext> and returns its URL. */
function emit(outDir: string, name: string, ext: string, content: string | Buffer): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const file = `${name}.${hash}.${ext}`;
  writeFileSync(join(outDir, file), content);
  return `/assets/${file}`;
}

/** TypeScript to an ES2022 module. The page scripts import nothing, so one file is one module. */
function compile(file: string): string {
  return ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true },
  }).outputText;
}

export function buildAssets({ root, outDir }: BuildOptions): AssetManifest {
  // Only this build's files: a name of an older build would still be served as immutable.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const ds = join(root, "design-system");
  const font = (file: string) => emit(outDir, file, "woff2", readFileSync(join(ds, "fonts", `${file}.woff2`)));
  const fonts = { geist: font("Geist-Variable"), geistItalic: font("Geist-Italic-Variable"), geistMono: font("GeistMono-Variable") };
  // tokens.css names its fonts relative to itself (url("fonts/Geist-Variable.woff2")).
  const fontUrl = (path: string) => Object.values(fonts).find((url) => url.startsWith(`/assets/${path.slice("fonts/".length, -".woff2".length)}.`));
  const css = [join(ds, "tokens.css"), join(ds, "components", "bundle.css"), join(root, "src", "assets", "app.css")]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
    .replace(/url\("(fonts\/[^"]+\.woff2)"\)/g, (whole, path: string) => {
      const url = fontUrl(path);
      return url ? `url("${url}")` : whole;
    });
  const manifest: AssetManifest = {
    styles: emit(outDir, "styles", "css", css),
    fonts,
    scripts: Object.fromEntries(CLIENT_SCRIPTS.map((s) => [s, emit(outDir, s, "js", compile(join(root, "src", "client", `${s}.ts`)))])) as Record<
      ClientScript,
      string
    >,
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// `node scripts/build-assets.ts [out folder]`, the second half of `pnpm build` (out: dist/assets).
if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  buildAssets({ root, outDir: process.argv[2] ?? join(root, "dist", "assets") });
}
