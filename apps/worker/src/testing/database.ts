import { randomBytes } from "node:crypto";
import { createPool, runMigrations, type DbPool } from "@ebay-sniper/db";
import { migrateQueue } from "@ebay-sniper/db/queue";

// Test helper, not built. ADR 0023: one database per test file, copied from a template that the
// global setup migrates once, pg-boss schema and queues included (section 2.2).

// Its own template, so the db package's tests can run at the same time.
export const TEMPLATE_DATABASE = "ebay_sniper_worker_template";

// The one place the worker tests read their database URL.
export function testDatabaseAdminUrl(): string {
  // eslint-disable-next-line no-restricted-syntax -- test setup, not app config: the URL of the test cluster
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("TEST_DATABASE_URL is not set: start Postgres, see README (Local Postgres for tests)");
  }
  return url;
}

function databaseUrl(adminUrl: string, name: string, role?: "worker"): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  // The superuser session switches to the role at connect, so no role password is needed and the
  // grants of section 2.5 apply to every statement.
  if (role !== undefined) url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

const adminPool = (connectionString: string): DbPool =>
  createPool({
    connectionString,
    max: 1,
    applicationName: "worker-test-admin",
    statementTimeoutMs: 60_000,
    onError: () => undefined,
  });

async function adminQuery(adminUrl: string, statement: string, params: unknown[] = []): Promise<void> {
  const pool = adminPool(adminUrl);
  try {
    await pool.query(statement, params);
  } finally {
    await pool.end();
  }
}

// The global setup: a fresh template with every migration and the pg-boss install.
export async function prepareTemplate(adminUrl: string): Promise<void> {
  await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
  await adminQuery(adminUrl, `CREATE DATABASE ${TEMPLATE_DATABASE}`);
  await runMigrations({
    connectionString: databaseUrl(adminUrl, TEMPLATE_DATABASE),
    log: () => undefined,
    afterDrizzle: async (client) => {
      await migrateQueue(client);
    },
  });
}

export type TestDatabase = {
  name: string;
  // Superuser on the test database: arranges rows and reads what the handlers wrote.
  admin: DbPool;
  // As role worker, sized like the worker pool.
  pool: DbPool;
  // As role worker, for pg-boss.
  workerUrl: string;
  drop(): Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testDatabaseAdminUrl();
  const name = `worker_test_${randomBytes(8).toString("hex")}`;
  await adminQuery(adminUrl, `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
  const admin = adminPool(databaseUrl(adminUrl, name));
  const workerUrl = databaseUrl(adminUrl, name, "worker");
  const pool = createPool({
    connectionString: workerUrl,
    max: 10,
    applicationName: "worker-test",
    statementTimeoutMs: 10_000,
    onError: () => undefined,
  });
  return {
    name,
    admin,
    pool,
    workerUrl,
    async drop() {
      await Promise.all([pool.end(), admin.end()]);
      await waitForNoSessions(adminUrl, name);
      await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

// pool.end() resolves before the sockets close. FORCE would terminate those sessions, and the
// error they then emit has no listener left, so wait until they are gone.
async function waitForNoSessions(adminUrl: string, name: string): Promise<void> {
  const pool = adminPool(adminUrl);
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await pool.query<{ sessions: number }>(
        "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1",
        [name],
      );
      if (result.rows[0]?.sessions === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await pool.end();
  }
}
