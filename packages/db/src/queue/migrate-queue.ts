import type pg from "pg";
import { getConstructionPlans } from "pg-boss";
import { pgBossQueues } from "./registry.js";
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION } from "./schema-version.js";

export { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION };

export type QueueMigrateResult = { schemaCreated: boolean; version: number; queuesCreated: string[] };

// Runs in the migrate runner, under the migrate advisory lock, as the owner role. The worker role
// owns every pg-boss object, so pg-boss maintenance at runtime never needs a superuser. No
// `new PgBoss({ migrate: true }).start()` (S1b note).
export class QueueSchemaVersionError extends Error {}

export async function migrateQueue(client: pg.ClientBase): Promise<QueueMigrateResult> {
  const installed = await installedVersion(client);
  if (installed !== null && installed < PGBOSS_SCHEMA_VERSION) {
    throw new QueueSchemaVersionError(`pg-boss schema ${installed} needs an upgrade path; not built in the MVP`);
  }
  if (installed !== null && installed > PGBOSS_SCHEMA_VERSION) {
    throw new QueueSchemaVersionError(`pg-boss schema ${installed}: database is newer than this release`);
  }
  if (installed === null) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${PGBOSS_SCHEMA} AUTHORIZATION worker`);
    await asWorker(client, async () => {
      await client.query(getConstructionPlans(PGBOSS_SCHEMA, { createSchema: false }));
    });
  }
  const queuesCreated = await createMissingQueues(client);
  return { schemaCreated: installed === null, version: PGBOSS_SCHEMA_VERSION, queuesCreated };
}

// One transaction as worker: every missing queue is created, or none. A queue that exists keeps
// its options; changing one needs its own step.
async function createMissingQueues(client: pg.ClientBase): Promise<string[]> {
  const existing = await client.query<{ name: string }>(`SELECT name FROM ${PGBOSS_SCHEMA}.queue`);
  const names = new Set(existing.rows.map((row) => row.name));
  const missing = pgBossQueues().filter((queue) => !names.has(queue.name));
  if (missing.length === 0) return [];
  await asWorker(client, async () => {
    await client.query("BEGIN");
    for (const queue of missing) {
      await client.query(`SELECT ${PGBOSS_SCHEMA}.create_queue($1, $2::jsonb)`, [queue.name, JSON.stringify(queue.options)]);
    }
    await client.query("COMMIT");
  });
  return missing.map((queue) => queue.name);
}

async function installedVersion(client: pg.ClientBase): Promise<number | null> {
  const table = await client.query<{ name: string | null }>(`SELECT to_regclass('${PGBOSS_SCHEMA}.version') AS name`);
  if (table.rows[0]?.name === null) return null;
  const result = await client.query<{ version: number }>(`SELECT version FROM ${PGBOSS_SCHEMA}.version`);
  return result.rows[0]?.version ?? null;
}

// A failed plan leaves the session in an aborted transaction; it is rolled back before the role
// is reset, so the error that broke the step is the one thrown.
async function asWorker(client: pg.ClientBase, fn: () => Promise<void>): Promise<void> {
  await client.query("SET ROLE worker");
  try {
    await fn();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.query("RESET ROLE");
  }
}
