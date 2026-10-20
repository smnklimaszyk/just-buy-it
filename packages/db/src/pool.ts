import pg from "pg";

export type DbPool = pg.Pool;

// A pool or a checked-out client.
export type Queryable = Pick<pg.ClientBase, "query">;

export function createPool(options: {
  connectionString: string;
  max: number;
  applicationName: string;
  onError: (error: Error) => void;
}): DbPool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    // 2 s to get a connection (also a free pool slot), 2 s per statement in Postgres, 3 s on the
    // client for a server that accepts TCP and never answers: no call takes longer than about 5 s.
    connectionTimeoutMillis: 2_000,
    query_timeout: 3_000,
    statement_timeout: 2_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
  });
  // An idle client that loses its connection (Postgres restart) emits "error" on the pool; without
  // a listener that event would end the process.
  pool.on("error", options.onError);
  return pool;
}
