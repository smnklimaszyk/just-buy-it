import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec 10.4: since v2, products are data, so the words of the MVP's six segments stay out of the
// code under apps/*/src and packages/*/src, testing/ folders included. Tests, fixtures,
// migrations, evals and docs may keep them, and so may JSON test data (spec 10.5).
const repo = fileURLToPath(new URL("../../../", import.meta.url));

const PRODUCT_LITERALS = ["3090", "4090", "ddr4", "ddr5", "gpu_", "ram_ddr", "pc_4090", "27386", "170083", "rtx"];

const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|css)$/;
const TEST_FILE = /\.test\.tsx?$/;
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "fixtures", "migrations", "evals", "__snapshots__"]);

// The checks of the legacy tables app.feed and app.segment_rule keep the SQL of migration 0004
// until a contract migration drops the tables (spec 10.5). Only these lines may name the segments.
const ALLOWED_LINES: Readonly<Record<string, readonly string[]>> = {
  "packages/db/src/schema/app.ts": ['check("feed_id_known"', 'check("segment_rule_segment_known"'],
};

type Found = { line: number; literal: string };

function literalsIn(text: string, allowedLines: readonly string[] = []): Found[] {
  return text.split("\n").flatMap((line, index) => {
    if (allowedLines.some((allowed) => line.includes(allowed))) return [];
    const lower = line.toLowerCase();
    return PRODUCT_LITERALS.filter((literal) => lower.includes(literal)).map((literal) => ({ line: index + 1, literal }));
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : filesUnder(path);
    return CODE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

// Repo-relative paths of every checked file.
function codeFiles(): string[] {
  return ["apps", "packages"].flatMap((top) =>
    readdirSync(join(repo, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(repo, top, entry.name, "src")))
      .flatMap((entry) => filesUnder(join(repo, top, entry.name, "src")))
      .map((path) => relative(repo, path)),
  );
}

describe("literalsIn", () => {
  it("finds each product word in any case, with its line, and skips an allowed line only", () => {
    const text = 'const a = 1;\nconst title = "Synthetic RTX 3090";\ncheck("feed_id_known", sql`gpu_3090`)\ncheck("x", sql`ram_ddr5`)';

    expect(literalsIn(text, ['check("feed_id_known"'])).toEqual([
      { line: 2, literal: "3090" },
      { line: 2, literal: "rtx" },
      { line: 4, literal: "ddr5" },
      { line: 4, literal: "ram_ddr" },
    ]);
  });
});

describe("codeFiles", () => {
  it("checks testing folders and leaves out tests, fixtures, snapshots and JSON data", () => {
    const files = codeFiles();

    expect(files).toContain("apps/worker/src/testing/ebay.ts");
    expect(files).toContain("packages/kleinanzeigen/src/testing/alert-email.ts");
    expect(files).toContain("packages/db/src/schema/app.ts");
    expect(files.filter((file) => TEST_FILE.test(file) || file.endsWith(".json"))).toEqual([]);
    expect(files.filter((file) => file.split("/").some((part) => SKIPPED_FOLDERS.has(part)))).toEqual([]);
  });
});

// Spec 10.4: the segment code, the old classifier and call plan, and the MVP dashboard go in v2.
const REMOVED_MODULES = [
  "packages/domain/src/segments.ts",
  "packages/domain/src/rules.ts",
  "packages/domain/src/classify/classify.ts",
  "packages/domain/src/classify/ram-capacity.ts",
  "packages/domain/fixtures/titles.v1.ts",
  "packages/db/src/dashboard.ts",
  "packages/db/src/feed.ts",
  "apps/server/src/dashboard.ts",
  "apps/server/src/dashboard-html.ts",
];

// Every .ts and .tsx file of the workspace packages, tests included.
function allSourceFiles(): string[] {
  return ["apps", "packages", "tools"].flatMap((top) =>
    readdirSync(join(repo, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => filesUnderAll(join(repo, top, entry.name)))
      .map((path) => relative(repo, path)),
  );
}

function filesUnderAll(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : filesUnderAll(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("removed modules (spec 10.4)", () => {
  it("are gone, nothing imports them, and planDailyCalls has one definition", () => {
    const removedImports = REMOVED_MODULES.map((module) => module.replace(/^.*\/(?:src|fixtures)\//, "").replace(/\.ts$/, ".js"));
    const files = allSourceFiles();
    const importsOfRemoved = files.flatMap((file) =>
      readFileSync(join(repo, file), "utf8")
        .split("\n")
        .filter((line) => /^\s*(import|export)\b|^\s*\} from /.test(line))
        .filter((line) => removedImports.some((module) => line.includes(`/${module}"`) || line.includes(`"./${module}"`)))
        .map((line) => `${file}: ${line.trim()}`),
    );
    const planDefinitions = files.filter(
      (file) => !TEST_FILE.test(file) && /export function planDailyCalls\b/.test(readFileSync(join(repo, file), "utf8")),
    );

    expect(REMOVED_MODULES.filter((module) => existsSync(join(repo, module)))).toEqual([]);
    expect(importsOfRemoved).toEqual([]);
    expect(planDefinitions).toEqual(["packages/domain/src/plan/budget.ts"]);
  });
});

describe("no product literals in the code (spec 10.4)", () => {
  it("finds none of the MVP's product words under apps/*/src and packages/*/src", () => {
    const found = codeFiles().flatMap((file) =>
      literalsIn(readFileSync(join(repo, file), "utf8"), ALLOWED_LINES[file]).map(
        ({ line, literal }) => `${file}:${line} ${literal}`,
      ),
    );

    expect(found).toEqual([]);
  });
});
