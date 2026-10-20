import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

// Roles and role settings live in shared catalogs, so two databases of one cluster that change
// the same role at once fail with "tuple concurrently updated". Advisory locks are scoped to the
// database they are taken in, so this key is only cluster-wide because every holder takes it in
// the postgres database.
export const ROLE_LOCK_KEY = 7305508719787207781n; // 0x65626179726f6c65, ASCII "ebayrole"

export class MigrateLockTimeoutError extends Error {}

export async function withRoleLock<T>(
  connectionString: string,
  options: { attempts: number; retryMs: number },
  fn: (attempts: number) => Promise<T>,
): Promise<T> {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
  // A lost connection also rejects the pending query, which carries the error.
  client.on("error", () => undefined);
  await client.connect();
  try {
    const attempts = await acquireAdvisoryLock(client, ROLE_LOCK_KEY, options, "another session held the role lock");
    try {
      return await fn(attempts);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ROLE_LOCK_KEY.toString()]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

// Counting attempts instead of measuring elapsed time keeps the clock out of the runner.
export async function acquireAdvisoryLock(
  client: pg.Client,
  key: bigint,
  options: { attempts: number; retryMs: number },
  holder: string,
): Promise<number> {
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
      key.toString(),
    ]);
    if (result.rows[0]?.locked === true) return attempt;
    if (attempt < options.attempts) await sleep(options.retryMs);
  }
  throw new MigrateLockTimeoutError(`${holder} for ${options.attempts} attempts`);
}
