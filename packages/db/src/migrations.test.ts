import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR 0005: migrations are expand-only. Destructive statements live only in *_contract.sql files,
// and nothing writes listing rows from a migration.

type Journal = { entries: { idx: number; when: number; tag: string }[] };

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));

function fileProblems(name: string, sql: string): string[] {
  const problems: string[] = [];
  if (!name.endsWith("_contract.sql") && /\b(DROP|RENAME)\b/i.test(sql)) {
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
