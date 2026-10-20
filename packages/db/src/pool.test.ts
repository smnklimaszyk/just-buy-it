import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool } from "./pool.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

const adminUrl = inject("testDatabaseAdminUrl");

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

// Accepts TCP connections and never answers: a Postgres that hangs.
async function silentServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the silent server has no port");
  return {
    url: `postgres://app:x@127.0.0.1:${address.port}/x`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("createPool", () => {
  it("runs sessions with a 2 s statement timeout and the given application name", async () => {
    const pool = createPool({
      connectionString: database.url,
      max: 1,
      applicationName: "pool-test",
      onError: () => undefined,
    });
    try {
      const result = await pool.query<{ statement_timeout: string; application_name: string }>(
        "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('application_name') AS application_name",
      );

      expect(result.rows[0]).toEqual({ statement_timeout: "2s", application_name: "pool-test" });
    } finally {
      await pool.end();
    }
  });

  it("sets the fixed connection, query and idle timeouts", async () => {
    const pool = createPool({ connectionString: database.url, max: 3, applicationName: "pool-test", onError: () => undefined });
    try {
      expect(pool.options).toMatchObject({
        max: 3,
        connectionTimeoutMillis: 2_000,
        query_timeout: 3_000,
        statement_timeout: 2_000,
        idleTimeoutMillis: 30_000,
        keepAlive: true,
      });
    } finally {
      await pool.end();
    }
  });

  it("rejects a query within 4 s when the server accepts TCP and never answers (A4)", { timeout: 10_000 }, async () => {
    const server = await silentServer();
    const pool = createPool({ connectionString: server.url, max: 1, applicationName: "pool-test", onError: () => undefined });
    try {
      const started = performance.now();

      await expect(pool.query("SELECT 1")).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(4_000);
    } finally {
      await pool.end();
      await server.close();
    }
  });

  it("hands the error of an idle client that loses its connection to onError instead of crashing", async () => {
    const errors: Error[] = [];
    const pool = createPool({
      connectionString: database.url,
      max: 1,
      applicationName: "pool-test-idle",
      onError: (error) => errors.push(error),
    });
    try {
      await pool.query("SELECT 1");
      await database.pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pool-test-idle'",
      );

      await expect.poll(() => errors.length).toBe(1);
      expect(errors[0]).toBeInstanceOf(Error);
    } finally {
      await pool.end();
    }
  });
});
