import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { acquireAdvisoryLock, withRoleLock } from "./role-lock.js";

export { MigrateLockTimeoutError } from "./role-lock.js";

export const MIGRATE_LOCK_KEY = 7305508719803918704n; // 0x65626179736e6970, ASCII "ebaysnip"

export class MigrationHistoryError extends Error {}

export type MigrateLog = (entry: { event: "migrate"; step: string; [key: string]: unknown }) => void;
export type MigrateResult = { drizzleApplied: number; newerThanRelease: number };
export type MigrateLogStep = (step: string, fields?: Record<string, unknown>) => void;
// Runs after the Drizzle step on the runner's client, still under the migrate lock and outside
// the role lock (ops migrate: role passwords, then the pg-boss schema and queues, section 2.2).
export type AfterDrizzle = (client: pg.Client, logStep: MigrateLogStep) => Promise<void>;

const ROLE_LOCK_ATTEMPTS = 120;

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function runMigrations(options: {
  connectionString: string;
  log: MigrateLog;
  migrationsFolder?: string;
  lockAttempts?: number;
  lockRetryMs?: number;
  afterDrizzle?: AfterDrizzle;
}): Promise<MigrateResult> {
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const lockAttempts = options.lockAttempts ?? 120;
  const lockRetryMs = options.lockRetryMs ?? 500;
  // Durations come from the monotonic timer, not the wall clock (ADR 0008).
  const started = performance.now();
  let stepStarted = started;
  const logStep = (step: string, fields: Record<string, unknown> = {}): void => {
    const now = performance.now();
    options.log({ event: "migrate", step, ...fields, duration_ms: Math.round(now - stepStarted) });
    stepStarted = now;
  };

  const client = new pg.Client({ connectionString: options.connectionString, connectionTimeoutMillis: 10_000 });
  // A lost connection also rejects the pending query, which carries the error; without a listener
  // the event would crash the process before the failure is logged.
  client.on("error", () => undefined);
  await client.connect();
  try {
    // A migration waiting on a table lock, or a runaway statement, fails instead of holding the deploy.
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '5min'");
    const attempts = await acquireAdvisoryLock(
      client,
      MIGRATE_LOCK_KEY,
      { attempts: lockAttempts, retryMs: lockRetryMs },
      "another migrate run held the lock",
    );
    logStep("lock_acquired", { attempts });
    try {
      // ADR 0008: new sessions run in UTC whatever the server default is.
      await client.query(
        "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'); END $$",
      );
      const newerThanRelease = await checkHistory(client, migrationsFolder);
      const before = await countApplied(client);
      logStep("history", { applied: before, newer_than_release: newerThanRelease });
      // Lock order is always this database's lock, then the role lock. The role lock waits its own
      // 120 attempts: other databases of the cluster hold it only for their drizzle step.
      const drizzleApplied = await withRoleLock(
        options.connectionString,
        { attempts: ROLE_LOCK_ATTEMPTS, retryMs: lockRetryMs },
        async (roleLockAttempts) => {
          logStep("role_lock_acquired", { attempts: roleLockAttempts });
          await migrate(drizzle(client), {
            migrationsFolder,
            migrationsSchema: "drizzle",
            migrationsTable: "__drizzle_migrations",
          });
          return (await countApplied(client)) - before;
        },
      );
      logStep("drizzle", { applied: drizzleApplied });
      if (options.afterDrizzle !== undefined) await options.afterDrizzle(client, logStep);
      options.log({
        event: "migrate",
        step: "done",
        drizzle_applied: drizzleApplied,
        newer_than_release: newerThanRelease,
        duration_ms: Math.round(performance.now() - started),
      });
      return { drizzleApplied, newerThanRelease };
    } finally {
      // If the connection is gone, ending the session frees the lock, and the error that broke the
      // run is the one worth throwing.
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY.toString()]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

type AppliedMigration = { hash: string; createdAt: number };

// Drizzle 0.45.4 compares only the journal's `when` with the last applied created_at and never
// the hashes, so an edited or out-of-order migration would go unnoticed without this check.
async function checkHistory(client: pg.Client, migrationsFolder: string): Promise<number> {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const files = readMigrationFiles({ migrationsFolder });
  const applied = await appliedMigrations(client);
  const newestApplied = applied.at(-1)?.createdAt ?? Number.NEGATIVE_INFINITY;

  files.forEach((file, position) => {
    const tag = journal.entries[position]?.tag ?? `entry ${position}`;
    const row = applied.find((migration) => migration.createdAt === file.folderMillis);
    if (row !== undefined && row.hash !== file.hash) {
      throw new MigrationHistoryError(`applied migration ${tag} was edited`);
    }
    if (row === undefined && file.folderMillis <= newestApplied) {
      throw new MigrationHistoryError(`migration ${tag} is older than the last applied one and would be skipped`);
    }
    const previous = files[position - 1];
    if (previous !== undefined && file.folderMillis <= previous.folderMillis) {
      throw new MigrationHistoryError(`journal entry ${tag} is not newer than the entry before it`);
    }
  });

  // Rows newer than this folder's last entry: an older release deployed over a newer,
  // expand-only schema (ADR 0005). Drizzle then applies nothing.
  const newestInFolder = files.at(-1)?.folderMillis ?? Number.NEGATIVE_INFINITY;
  return applied.filter((migration) => migration.createdAt > newestInFolder).length;
}

async function appliedMigrations(client: pg.Client): Promise<AppliedMigration[]> {
  if ((await countApplied(client)) === 0) return [];
  const result = await client.query<{ hash: string; created_at: string }>(
    "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
  );
  return result.rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

async function countApplied(client: pg.Client): Promise<number> {
  const exists = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
  );
  if (exists.rows[0]?.exists !== true) return 0;
  const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations");
  return result.rows[0]?.count ?? 0;
}
