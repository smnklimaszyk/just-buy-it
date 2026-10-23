import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYNCED_FILES, syncDesignSystem } from "./sync.ts";

const ICONS_TS = `// Generated from lucide@0.468.0 (ISC).
export const ICONS: Record<string, [string, Record<string, any>][]> = {"check":[["path",{"d":"M20 6 9 17l-5-5"}]],"x":[["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],"sun":[["circle",{"cx":"12","cy":"12","r":"4"}]]};
`;

let root: string;
let source: string;
let target: string;
let notices: string;

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else out.push(relative(target, path));
  }
  return out.sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-ds-"));
  source = join(root, "design-system");
  target = join(root, "web", "design-system");
  notices = join(root, "notices");
  put(join(source, "tokens.css"), ":root { --bg: white; }\n");
  put(join(source, "components", "bundle.css"), ".ia-btn { color: var(--fg); }\n");
  put(join(source, "components", "index.d.ts"), "export type IconName = 'check' | 'x';\n");
  put(join(source, "components", "src", "icons.ts"), ICONS_TS);
  put(join(source, "components", "src", "core.tsx"), "export function Button() {}\n");
  put(join(source, "README.md"), "brand book\n");
  put(join(source, "assets", "logo", "logo.svg"), "<svg/>\n");
  for (const font of ["Geist-Variable.woff2", "Geist-Italic-Variable.woff2", "GeistMono-Variable.woff2"]) {
    put(join(source, "fonts", font), `wOF2 ${font}`);
  }
  put(join(notices, "Geist-OFL.txt"), "SIL OPEN FONT LICENSE Version 1.1\n");
  put(join(notices, "Lucide-ISC.txt"), "ISC License\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("syncDesignSystem", () => {
  it("copies tokens.css unchanged", () => {
    syncDesignSystem({ source, target, notices, icons: ["check", "x"] });

    expect(readFileSync(join(target, "tokens.css"), "utf8")).toBe(":root { --bg: white; }\n");
  });

  it("copies the component CSS, the typings, the fonts and the licence notices", () => {
    syncDesignSystem({ source, target, notices, icons: ["check"] });

    expect(readFileSync(join(target, "components", "bundle.css"), "utf8")).toBe(".ia-btn { color: var(--fg); }\n");
    expect(readFileSync(join(target, "components", "index.d.ts"), "utf8")).toBe("export type IconName = 'check' | 'x';\n");
    for (const font of ["Geist-Variable.woff2", "Geist-Italic-Variable.woff2", "GeistMono-Variable.woff2"]) {
      expect(readFileSync(join(target, "fonts", font), "utf8")).toBe(`wOF2 ${font}`);
    }
    expect(readFileSync(join(target, "fonts", "OFL.txt"), "utf8")).toBe("SIL OPEN FONT LICENSE Version 1.1\n");
    expect(readFileSync(join(target, "icons-LICENSE.txt"), "utf8")).toBe("ISC License\n");
  });

  it("writes the paths of the listed icons only", () => {
    syncDesignSystem({ source, target, notices, icons: ["check", "x"] });

    expect(JSON.parse(readFileSync(join(target, "icons.json"), "utf8"))).toEqual({
      check: [["path", { d: "M20 6 9 17l-5-5" }]],
      x: [
        ["path", { d: "M18 6 6 18" }],
        ["path", { d: "m6 6 12 12" }],
      ],
    });
  });

  it("refuses an icon the design system does not have and writes nothing", () => {
    expect(() => syncDesignSystem({ source, target, notices, icons: ["check", "rocket"] })).toThrow(
      "icon rocket is not in the design system",
    );
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a source without one of the files and writes nothing", () => {
    rmSync(join(source, "components", "index.d.ts"));

    expect(() => syncDesignSystem({ source, target, notices, icons: ["check"] })).toThrow(
      /components\/index\.d\.ts is missing/,
    );
    expect(existsSync(target)).toBe(false);
  });

  it("leaves only the files on the list, removing the brand book and component sources of an older copy", () => {
    put(join(target, "components", "src", "core.tsx"), "old copy\n");
    put(join(target, "README.md"), "old brand book\n");

    syncDesignSystem({ source, target, notices, icons: ["check"] });

    expect(listFiles(target)).toEqual([...SYNCED_FILES].sort());
    expect(existsSync(join(target, "components", "src"))).toBe(false);
  });

  it("writes a notice that names where the files come from, their licences and the source commit", () => {
    syncDesignSystem({ source, target, notices, icons: ["check"] });

    const notice = readFileSync(join(target, "NOTICE.md"), "utf8");
    expect(notice).toContain("tools/sync-design-system");
    expect(notice).toContain("SIL Open Font License 1.1");
    expect(notice).toContain("Lucide");
    expect(notice).toContain("Source commit: not a git checkout");
  });
});
