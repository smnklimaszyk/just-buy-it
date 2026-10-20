import { randomBytes } from "node:crypto";
import pg from "pg";

// Test helper, not exported and not built. ADR 0023: one database per test file.
export const TEMPLATE_DATABASE = "ebay_sniper_template";

export type TestDatabase = { url: string; pool: pg.Pool; drop(): Promise<void> };

export async function createTestDatabase(
  adminUrl: string,
  options: { from: "template" | "empty" },
): Promise<TestDatabase> {
  const name = `test_${randomBytes(8).toString("hex")}`;
  const template = options.from === "template" ? ` TEMPLATE ${TEMPLATE_DATABASE}` : "";
  await adminQuery(adminUrl, `CREATE DATABASE ${name}${template}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });

  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      // pool.end() resolves before the clients' sockets close. FORCE would terminate those clients,
      // and the 57P01 they then emit has no listener left, so wait until the sessions are gone.
      await waitForNoSessions(adminUrl, name);
      await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

async function waitForNoSessions(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await client.query<{ sessions: number }>(
        "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1",
        [name],
      );
      if (result.rows[0]?.sessions === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await client.end();
  }
}

export async function adminQuery(adminUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
