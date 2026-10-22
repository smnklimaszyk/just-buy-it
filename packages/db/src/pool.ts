import pg from "pg";

export type DbPool = pg.Pool;

// A pool or a checked-out client.
export type Queryable = Pick<pg.ClientBase, "query">;

export function createPool(options: {
  connectionString: string;
  max: number;
  applicationName: string;
  // Default 2 s (server pools). The worker passes DB_STATEMENT_TIMEOUT_MS (10 s by default).
  statementTimeoutMs?: number;
  onError: (error: Error) => void;
}): DbPool {
  const statementTimeoutMs = options.statementTimeoutMs ?? 2_000;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    // 2 s to get a connection (also a free pool slot), the statement timeout in Postgres, and 1 s
    // more on the client for a server that accepts TCP and never answers. With the default no call
    // takes longer than about 5 s.
    connectionTimeoutMillis: 2_000,
    query_timeout: statementTimeoutMs + 1_000,
    statement_timeout: statementTimeoutMs,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
  });
  // An idle client that loses its connection (Postgres restart) emits "error" on the pool; without
  // a listener that event would end the process.
  pool.on("error", options.onError);
  return pool;
}
