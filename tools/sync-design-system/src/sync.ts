import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FONTS = ["Geist-Variable.woff2", "Geist-Italic-Variable.woff2", "GeistMono-Variable.woff2"];

// Target path, and where it comes from. Owner decision 1 (spec section 12): tokens, the
// component CSS, the typings, the fonts with their OFL notice and the icon paths used.
const COPIED: readonly (readonly [target: string, from: "source" | "notices", path: string])[] = [
  ["tokens.css", "source", "tokens.css"],
  [join("components", "bundle.css"), "source", join("components", "bundle.css")],
  [join("components", "index.d.ts"), "source", join("components", "index.d.ts")],
  ...FONTS.map((font) => [join("fonts", font), "source", join("fonts", font)] as const),
  [join("fonts", "OFL.txt"), "notices", "Geist-OFL.txt"],
  ["icons-LICENSE.txt", "notices", "Lucide-ISC.txt"],
];

export const SYNCED_FILES: readonly string[] = [...COPIED.map(([target]) => target), "icons.json", "NOTICE.md"];

export interface SyncOptions {
  source: string;
  target: string;
  notices: string;
  icons: readonly string[];
}

type IconParts = [string, Record<string, string>][];

// icons.ts is `export const ICONS: ... = {...};` with a JSON object literal.
function readIcons(source: string): Record<string, IconParts> {
  const text = readFileSync(join(source, "components", "src", "icons.ts"), "utf8");
  const start = text.indexOf("{", text.indexOf("="));
  return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as Record<string, IconParts>;
}

export function syncDesignSystem(options: SyncOptions): void {
  const all = readIcons(options.source);
  const used: Record<string, IconParts> = {};
  for (const name of options.icons) {
    const parts = all[name];
    if (!parts) throw new Error(`icon ${name} is not in the design system`);
    used[name] = parts;
  }
  for (const [, from, sourcePath] of COPIED) {
    const path = join(from === "source" ? options.source : options.notices, sourcePath);
    if (!existsSync(path)) throw new Error(`${path} is missing`);
  }
  // Start from an empty folder so nothing of an older copy stays behind.
  rmSync(options.target, { recursive: true, force: true });
  for (const [path, from, sourcePath] of COPIED) {
    const out = join(options.target, path);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(join(from === "source" ? options.source : options.notices, sourcePath), out);
  }
  writeFileSync(join(options.target, "icons.json"), `${JSON.stringify(used, null, 2)}\n`);
  writeFileSync(join(options.target, "NOTICE.md"), notice(sourceCommit(options.source)));
}

function sourceCommit(source: string): string {
  if (!existsSync(join(source, ".git"))) return "not a git checkout";
  return execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function notice(commit: string): string {
  return `# Design system files

Written by \`tools/sync-design-system\` from the Intra AI design system. Do not edit them here:
change the design system, then run \`pnpm --filter @ebay-sniper/sync-design-system sync\`.

Source commit: ${commit}

| File | Origin | Licence |
| --- | --- | --- |
| \`tokens.css\`, \`components/bundle.css\`, \`components/index.d.ts\` | Intra AI design system | Intra AI; committed by owner decision 1 of the v2 spec |
| \`fonts/*.woff2\` | Geist and Geist Mono, The Geist Project Authors | SIL Open Font License 1.1, see \`fonts/OFL.txt\` |
| \`icons.json\` | Path data of the icons the UI uses, from Lucide 0.468.0 | ISC, see \`icons-LICENSE.txt\` |
`;
}
