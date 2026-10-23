import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR 0005: migrations are expand-only. Destructive statements live only in *_contract.sql files,
// and nothing writes listing rows from a migration.

type Journal = { entries: { idx: number; when: number; tag: string }[] };

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));

const IDENTIFIER = String.raw`(?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?`;
// v2 amendment of ADR 0005: a check replaced by one with the same name in one statement, and a
// column made nullable. The statement may carry exactly one DROP and no RENAME.
const LOOSER_FORMS = [
  new RegExp(String.raw`^ALTER TABLE ${IDENTIFIER} DROP CONSTRAINT ("?[a-z0-9_]+"?), ADD CONSTRAINT \1 CHECK \(.*\);?$`, "is"),
  new RegExp(String.raw`^ALTER TABLE ${IDENTIFIER} ALTER COLUMN ${IDENTIFIER} DROP NOT NULL;?$`, "is"),
];

// Statements split at breakpoints and semicolons, without full-line comments.
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:-->\s*statement-breakpoint)?/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

function loosensOnly(statement: string): boolean {
  if (/\bRENAME\b/i.test(statement) || (statement.match(/\bDROP\b/gi) ?? []).length !== 1) return false;
  return LOOSER_FORMS.some((form) => form.test(statement));
}

function fileProblems(name: string, sql: string): string[] {
  const problems: string[] = [];
  const destructive = statements(sql).filter((statement) => /\b(DROP|RENAME)\b/i.test(statement));
  if (!name.endsWith("_contract.sql") && !destructive.every(loosensOnly)) {
    problems.push(`${name}: DROP or RENAME outside a *_contract.sql file`);
  }
  if (/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?ebay_live"?\./i.test(sql)) {
    problems.push(`${name}: writes rows in ebay_live`);
  }
  return problems;
}

function journalProblems(journal: Journal, sqlFiles: string[]): string[] {
  const problems: string[] = [];
  journal.entries.forEach((entry, position) => {
    if (entry.idx !== position) problems.push(`entry ${position}: idx is ${entry.idx}`);
    const previous = journal.entries[position - 1];
    if (previous !== undefined && entry.when <= previous.when) {
      problems.push(`${entry.tag}: when is not after ${previous.tag}`);
    }
    if (!entry.tag.startsWith(`${String(entry.idx).padStart(4, "0")}_`)) {
      problems.push(`${entry.tag}: tag does not start with its idx`);
    }
    if (!sqlFiles.includes(`${entry.tag}.sql`)) problems.push(`${entry.tag}: no ${entry.tag}.sql`);
  });
  const tags = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  for (const file of sqlFiles) {
    if (!tags.has(file)) problems.push(`${file}: no journal entry`);
  }
  return problems;
}

function readFolder(): { journal: Journal; files: Map<string, string> } {
  const journal = JSON.parse(readFileSync(`${migrationsFolder}meta/_journal.json`, "utf8")) as Journal;
  const files = new Map(
    readdirSync(migrationsFolder)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(`${migrationsFolder}${name}`, "utf8")]),
  );
  return { journal, files };
}

describe("migrations folder", () => {
  it("follows the file and journal rules", () => {
    const { journal, files } = readFolder();

    expect(journal.entries.length).toBeGreaterThan(0);
    expect([...files].flatMap(([name, sql]) => fileProblems(name, sql))).toEqual([]);
    expect(journalProblems(journal, [...files.keys()])).toEqual([]);
  });
});

describe("file rules", () => {
  it("refuses DROP TABLE outside a contract file", () => {
    expect(fileProblems("0002_cleanup.sql", "DROP TABLE app.old;")).toEqual([
      "0002_cleanup.sql: DROP or RENAME outside a *_contract.sql file",
    ]);
    expect(fileProblems("0002_cleanup_contract.sql", "DROP TABLE app.old;")).toEqual([]);
  });

  it("accepts only the two looser forms of the v2 amendment outside a contract file (ADR 0005)", () => {
    const widened =
      `ALTER TABLE "app"."candidate" DROP CONSTRAINT "candidate_decision_known", ADD CONSTRAINT "candidate_decision_known" CHECK ("app"."candidate"."decision" IN ('pending', 'held'));`;
    const refused = (sql: string) => fileProblems("0010_x.sql", sql);
    const problem = ["0010_x.sql: DROP or RENAME outside a *_contract.sql file"];

    expect(refused(`-- one check replaced by a wider one\n${widened}\n--> statement-breakpoint\nSELECT 1;`)).toEqual([]);
    expect(refused('ALTER TABLE "app"."candidate" ALTER COLUMN "listing_id" DROP NOT NULL;')).toEqual([]);
    expect(refused('ALTER TABLE "app"."candidate" DROP CONSTRAINT "candidate_decision_known";')).toEqual(problem);
    expect(refused("ALTER TABLE app.candidate DROP CONSTRAINT a, ADD CONSTRAINT b CHECK (decision <> 'x');")).toEqual(problem);
    expect(refused("ALTER TABLE app.candidate DROP CONSTRAINT a, ADD CONSTRAINT a UNIQUE (item_key);")).toEqual(problem);
    expect(
      refused("ALTER TABLE app.candidate DROP CONSTRAINT a, ADD CONSTRAINT a CHECK (x > 0), DROP COLUMN y, ADD CONSTRAINT z CHECK (x > 0);"),
    ).toEqual(problem);
    expect(refused("ALTER TABLE app.candidate ALTER COLUMN listing_id DROP NOT NULL, DROP COLUMN feed_id;")).toEqual(problem);
    expect(refused("ALTER TABLE app.candidate RENAME COLUMN feed_id TO search_id;")).toEqual(problem);
    expect(refused(`${widened}\n--> statement-breakpoint\nDROP TABLE app.feed;`)).toEqual(problem);
  });

  it("refuses writes to ebay_live rows in any file", () => {
    expect(fileProblems("0003_fix_contract.sql", 'DELETE FROM "ebay_live"."listing";')).toEqual([
      "0003_fix_contract.sql: writes rows in ebay_live",
    ]);
  });
});

describe("journal rules", () => {
  it("refuses a when that is lower than the entry before it", () => {
    const journal = {
      entries: [
        { idx: 0, when: 2000, tag: "0000_a" },
        { idx: 1, when: 1000, tag: "0001_b" },
      ],
    };

    expect(journalProblems(journal, ["0000_a.sql", "0001_b.sql"])).toEqual(["0001_b: when is not after 0000_a"]);
  });

  it("refuses a file without a journal entry, a gap in idx and a tag without its idx", () => {
    const journal = {
      entries: [
        { idx: 0, when: 1000, tag: "0000_a" },
        { idx: 2, when: 2000, tag: "0001_b" },
      ],
    };

    expect(journalProblems(journal, ["0000_a.sql", "0001_b.sql", "0002_c.sql"])).toEqual([
      "entry 1: idx is 2",
      "0001_b: tag does not start with its idx",
      "0002_c.sql: no journal entry",
    ]);
  });
});
