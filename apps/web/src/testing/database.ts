import { randomBytes } from "node:crypto";
import { createPool, runMigrations, type DbPool } from "@ebay-sniper/db";

// Test helper, not built. ADR 0023: one database per test file, copied from a template that the
// global setup migrates once.

// Its own template, so the db and worker tests can run at the same time.
export const TEMPLATE_DATABASE = "ebay_sniper_web_template";

// The one place the web tests read their database URL.
export function testDatabaseAdminUrl(): string {
  // eslint-disable-next-line no-restricted-syntax -- test setup, not app config: the URL of the test cluster
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("TEST_DATABASE_URL is not set: start Postgres, see README (Local Postgres for tests)");
  }
  return url;
}

function databaseUrl(adminUrl: string, name: string, role?: "web"): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  // The superuser session switches to the role at connect, so no role password is needed and the
  // grants of spec 2.10 apply to every statement.
  if (role !== undefined) url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

const adminPool = (connectionString: string): DbPool =>
  createPool({ connectionString, max: 2, applicationName: "web-test-admin", statementTimeoutMs: 60_000, onError: () => undefined });

async function adminQuery(adminUrl: string, statement: string): Promise<void> {
  const pool = adminPool(adminUrl);
  try {
    await pool.query(statement);
  } finally {
    await pool.end();
  }
}

// The global setup: a fresh template with every migration.
export async function prepareTemplate(adminUrl: string): Promise<void> {
  await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
  await adminQuery(adminUrl, `CREATE DATABASE ${TEMPLATE_DATABASE}`);
  await runMigrations({ connectionString: databaseUrl(adminUrl, TEMPLATE_DATABASE), log: () => undefined });
}

export type TestDatabase = {
  // Superuser on the test database: arranges rows and reads what web wrote.
  admin: DbPool;
  // As role web, sized like web's pool.
  pool: DbPool;
  drop(): Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testDatabaseAdminUrl();
  const name = `web_test_${randomBytes(8).toString("hex")}`;
  await adminQuery(adminUrl, `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
  const admin = adminPool(databaseUrl(adminUrl, name));
  const pool = createPool({
    connectionString: databaseUrl(adminUrl, name, "web"),
    max: 4,
    applicationName: "web-test",
    onError: () => undefined,
  });
  return {
    admin,
    pool,
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
      const result = await pool.query<{ sessions: number }>("SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1", [name]);
      if (result.rows[0]?.sessions === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await pool.end();
  }
}
