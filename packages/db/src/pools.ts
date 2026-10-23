// Spec 9.1: the size of every Postgres pool outside the worker's own (WORKER_POOL_MAX in the queue
// registry). The services read their size from here, so the budget test sees what they open.
export const SERVICE_POOLS = {
  // apps/server, role app.
  server: 3,
  // pg-boss in the worker (packages/db/src/queue/start.ts).
  pgBoss: 4,
  // apps/web, role web.
  web: 4,
} as const;

// ops migrate at its peak: the runner's client, the role-lock client and the client that sets a
// role password.
export const OPS_CLI_CONNECTIONS = 3;

// Postgres keeps superuser_reserved_connections (default 3) for superusers only.
const RESERVED_CONNECTIONS = 3;

// The pools' sum against what non-superusers may open, or null when it fits.
export function connectionProblem(pools: Record<string, number>, maxConnections: number): string | null {
  const needed = Object.values(pools).reduce((sum, size) => sum + size, 0);
  const usable = maxConnections - RESERVED_CONNECTIONS;
  if (needed <= usable) return null;
  return `pools need ${needed} connections, Postgres allows ${usable} (max_connections ${maxConnections} - ${RESERVED_CONNECTIONS} reserved)`;
}
