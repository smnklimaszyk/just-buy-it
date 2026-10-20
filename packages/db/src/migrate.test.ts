import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, inject, it } from "vitest";
import { MIGRATE_LOCK_KEY, MigrateLockTimeoutError, MigrationHistoryError, runMigrations } from "./migrate.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

const adminUrl = inject("testDatabaseAdminUrl");
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const journalEntries = (
  JSON.parse(readFileSync(`${migrationsFolder}meta/_journal.json`, "utf8")) as { entries: unknown[] }
).entries.length;

const silent = (): void => undefined;

let databases: TestDatabase[] = [];

async function emptyDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase(adminUrl, { from: "empty" });
  databases.push(database);
  return database;
}

async function schemas(database: TestDatabase): Promise<string[]> {
  const result = await database.pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname IN ('app', 'drizzle', 'pgboss') ORDER BY nspname",
  );
  return result.rows.map((row) => row.nspname);
}

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

let folders: string[] = [];

// Copies the real migrations folder so a test can add, edit or remove migrations.
function copiedFolder(): {
  path: string;
  journal: { entries: JournalEntry[] };
  addMigration(tag: string, sql: string, when?: number): void;
  save(): void;
} {
  const path = mkdtempSync(join(tmpdir(), "ebay-sniper-migrations-"));
  folders.push(path);
  cpSync(migrationsFolder, path, { recursive: true });
  const journalPath = join(path, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };
  return {
    path,
    journal,
    addMigration(tag, sql, when) {
      const last = journal.entries.at(-1);
      if (last === undefined) throw new Error("the migrations folder has no entries");
      writeFileSync(join(path, `${tag}.sql`), sql);
      journal.entries.push({ ...last, idx: last.idx + 1, tag, when: when ?? last.when + 1 });
      this.save();
    },
    save() {
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// Drizzle wraps a failed statement in DrizzleQueryError; the pg error is its cause.
function databaseError(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

async function appliedHashes(database: TestDatabase): Promise<number> {
  const exists = await database.pool.query<{ exists: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
  );
  if (exists.rows[0]?.exists !== true) return 0;
  const rows = await database.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
  );
  return rows.rows[0]?.count ?? 0;
}

afterEach(async () => {
  await Promise.all(databases.map((database) => database.drop()));
  databases = [];
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  folders = [];
});

describe("runMigrations", () => {
  it("applies every migration to an empty database", async () => {
    const database = await emptyDatabase();

    const result = await runMigrations({ connectionString: database.url, log: silent });

    expect(result).toEqual({ drizzleApplied: journalEntries, newerThanRelease: 0 });
    expect(await schemas(database)).toEqual(["app", "drizzle"]);
  });

  it("applies nothing on a second run", async () => {
    const database = await emptyDatabase();
    await runMigrations({ connectionString: database.url, log: silent });

    const result = await runMigrations({ connectionString: database.url, log: silent });

    expect(result).toEqual({ drizzleApplied: 0, newerThanRelease: 0 });
  });

  it("applies each migration once when two runners start together (A12)", async () => {
    const database = await emptyDatabase();

    const results = await Promise.all([
      runMigrations({ connectionString: database.url, log: silent, lockRetryMs: 50 }),
      runMigrations({ connectionString: database.url, log: silent, lockRetryMs: 50 }),
    ]);

    expect(results.map((result) => result.drizzleApplied).sort()).toEqual([0, journalEntries]);
    const rows = await database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    expect(rows.rows[0]?.count).toBe(journalEntries);
  });

  it("gives up with MigrateLockTimeoutError while another session holds the lock", async () => {
    const database = await emptyDatabase();
    const holder = await database.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY.toString()]);

      await expect(
        runMigrations({ connectionString: database.url, log: silent, lockAttempts: 3, lockRetryMs: 50 }),
      ).rejects.toBeInstanceOf(MigrateLockTimeoutError);
      expect(await schemas(database)).toEqual([]);
    } finally {
      holder.release();
    }
  });

  it("rolls back a failing migration, applies nothing and frees the lock", async () => {
    const database = await emptyDatabase();
    const folder = copiedFolder();
    folder.addMigration("0002_broken", "SELECT 1/0;");

    const error = await rejection(
      runMigrations({ connectionString: database.url, log: silent, migrationsFolder: folder.path }),
    );
    expect(databaseError(error)).toMatchObject({ code: "22012" });
    expect(await appliedHashes(database)).toBe(0);

    const retry = await runMigrations({ connectionString: database.url, log: silent, lockAttempts: 1 });
    expect(retry.drizzleApplied).toBe(journalEntries);
  });

  it("throws the migration's own error when the connection dies during a migration", async () => {
    const database = await emptyDatabase();
    const folder = copiedFolder();
    folder.addMigration("0002_connection_dies", "SELECT pg_terminate_backend(pg_backend_pid());");

    const error = await rejection(
      runMigrations({ connectionString: database.url, log: silent, migrationsFolder: folder.path }),
    );

    // Not "Client has encountered a connection error and is not queryable" from the unlock.
    expect(databaseError(error)).toMatchObject({ message: "Connection terminated unexpectedly" });
  });

  it("sets the database time zone to UTC for new sessions (ADR 0008)", async () => {
    const database = await emptyDatabase();
    await database.pool.query("DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Europe/Berlin'); END $$");

    await runMigrations({ connectionString: database.url, log: silent });

    const session = new pg.Client({ connectionString: database.url });
    await session.connect();
    try {
      const result = await session.query<{ TimeZone: string }>("SHOW TimeZone");
      expect(result.rows[0]?.TimeZone).toBe("UTC");
    } finally {
      await session.end();
    }
  });

  it("refuses an applied migration that was edited and applies nothing", async () => {
    const database = await emptyDatabase();
    await runMigrations({ connectionString: database.url, log: silent });
    const folder = copiedFolder();
    const first = join(folder.path, "0000_foundations.sql");
    writeFileSync(first, `${readFileSync(first, "utf8")}\n-- an edit after release\n`);
    folder.addMigration("0002_after_edit", "CREATE TABLE app.after_edit (x integer);");

    await expect(
      runMigrations({ connectionString: database.url, log: silent, migrationsFolder: folder.path }),
    ).rejects.toThrow(new MigrationHistoryError("applied migration 0000_foundations was edited"));
    expect(await appliedHashes(database)).toBe(journalEntries);
  });

  it("refuses a new migration older than the last applied one, which Drizzle would skip", async () => {
    const database = await emptyDatabase();
    await runMigrations({ connectionString: database.url, log: silent });
    const folder = copiedFolder();
    const lastWhen = folder.journal.entries.at(-1)?.when ?? 0;
    const tag = `${String(journalEntries).padStart(4, "0")}_late`;
    folder.addMigration(tag, "CREATE TABLE app.late (x integer);", lastWhen - 1);

    const error = await rejection(
      runMigrations({ connectionString: database.url, log: silent, migrationsFolder: folder.path }),
    );

    expect(error).toBeInstanceOf(MigrationHistoryError);
    expect((error as Error).message).toContain(`migration ${tag} is older than the last applied one and would be skipped`);
    expect(await appliedHashes(database)).toBe(journalEntries);
    const late = await database.pool.query<{ exists: boolean }>("SELECT to_regclass('app.late') IS NOT NULL AS exists");
    expect(late.rows[0]?.exists).toBe(false);
  });

  it("refuses a journal whose when values do not strictly increase, even on an empty database", async () => {
    const database = await emptyDatabase();
    const folder = copiedFolder();
    const lastWhen = folder.journal.entries.at(-1)?.when ?? 0;
    const tag = `${String(journalEntries).padStart(4, "0")}_same_when`;
    folder.addMigration(tag, "CREATE TABLE app.same_when (x integer);", lastWhen);

    await expect(
      runMigrations({ connectionString: database.url, log: silent, migrationsFolder: folder.path }),
    ).rejects.toThrow(new MigrationHistoryError(`journal entry ${tag} is not newer than the entry before it`));
    expect(await appliedHashes(database)).toBe(0);
  });

  it("accepts an older release over a newer schema and counts the newer migrations", async () => {
    const database = await emptyDatabase();
    await runMigrations({ connectionString: database.url, log: silent });
    const folder = copiedFolder();
    const newest = folder.journal.entries.pop();
    rmSync(join(folder.path, `${newest?.tag}.sql`));
    folder.save();
    const lines: Record<string, unknown>[] = [];

    const result = await runMigrations({
      connectionString: database.url,
      log: (entry) => lines.push(entry),
      migrationsFolder: folder.path,
    });

    expect(result).toEqual({ drizzleApplied: 0, newerThanRelease: 1 });
    expect(lines).toContainEqual(expect.objectContaining({ event: "migrate", step: "history", newer_than_release: 1 }));
  });

  it("runs migrations with a 10 s lock timeout and a 5 min statement timeout", async () => {
    const database = await emptyDatabase();
    const folder = copiedFolder();
    folder.addMigration(
      `${String(journalEntries).padStart(4, "0")}_check`,
      "DO $$ BEGIN IF current_setting('lock_timeout') <> '10s' OR current_setting('statement_timeout') <> '5min' THEN RAISE EXCEPTION 'session timeouts not set'; END IF; END $$;",
    );

    const result = await runMigrations({ connectionString: database.url, log: silent, migrationsFolder: folder.path });

    expect(result.drizzleApplied).toBe(journalEntries + 1);
  });

  it("fails on lock_timeout when a table lock is held and frees the advisory lock", { timeout: 20_000 }, async () => {
    const database = await emptyDatabase();
    await runMigrations({ connectionString: database.url, log: silent });
    const folder = copiedFolder();
    folder.addMigration(
      `${String(journalEntries).padStart(4, "0")}_alter`,
      "ALTER TABLE app.ebay_quota_window ADD COLUMN x integer;",
    );
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE app.ebay_quota_window IN ACCESS SHARE MODE");

      const started = performance.now();
      const error = await rejection(
        runMigrations({ connectionString: database.url, log: silent, migrationsFolder: folder.path }),
      );

      expect(performance.now() - started).toBeLessThan(15_000);
      expect(databaseError(error)).toMatchObject({ code: "55P03" });
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
    expect(await appliedHashes(database)).toBe(journalEntries);
    const column = await database.pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'ebay_quota_window' AND column_name = 'x'",
    );
    expect(column.rowCount).toBe(0);
    const lock = await database.pool.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
      MIGRATE_LOCK_KEY.toString(),
    ]);
    expect(lock.rows[0]?.locked).toBe(true);
  });

  it("logs one line per step and never the connection string", async () => {
    const database = await emptyDatabase();
    const lines: Record<string, unknown>[] = [];

    await runMigrations({ connectionString: database.url, log: (entry) => lines.push(entry) });

    expect(lines.map((line) => line.step)).toEqual(["lock_acquired", "history", "drizzle", "done"]);
    expect(lines.find((line) => line.step === "drizzle")).toMatchObject({ applied: journalEntries });
    for (const line of lines) expect(line).toMatchObject({ event: "migrate", duration_ms: expect.any(Number) });
    const password = new URL(database.url).password;
    expect(JSON.stringify(lines)).not.toContain(password);
  });

  it("gives up connecting to an unreachable host within 15 s", { timeout: 20_000 }, async () => {
    const started = performance.now();

    await expect(
      runMigrations({ connectionString: "postgres://user:secret@10.255.255.1:5432/none", log: silent }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});
