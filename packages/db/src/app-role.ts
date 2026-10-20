import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import { addHourlyCounts, recordDeletionEvent, recordProbeSeen } from "./deletion.js";
import { withRoleLock } from "./role-lock.js";

// Gives the role app LOGIN and the current password. Postgres stores a value that is already in
// SCRAM-SHA-256 form as the verifier, so the plaintext never reaches Postgres: not its log, not
// pg_stat_activity, not pg_stat_statements.
export async function setAppRolePassword(
  connectionString: string,
  password: string,
  options: { lockAttempts?: number; lockRetryMs?: number } = {},
): Promise<void> {
  const lock = { attempts: options.lockAttempts ?? 120, retryMs: options.lockRetryMs ?? 500 };
  await withRoleLock(connectionString, lock, async () => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
    client.on("error", () => undefined);
    await client.connect();
    try {
      await client.query(`ALTER ROLE app WITH LOGIN PASSWORD ${client.escapeLiteral(scramVerifier(password))}`);
    } finally {
      await client.end();
    }
  });
}

export class AppRoleCheckError extends Error {}

// Connects as app with the URL the server will use and runs the server's own writes inside a
// transaction that is rolled back, so a wrong grant or password stops the deploy, not the server.
export async function checkAppRole(appConnectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString: appConnectionString, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await step("connect", () => client.connect());
  try {
    // The hour comes from the database clock: packages do not read the system clock (ADR 0008).
    const hour = await step("begin", async () => {
      await client.query("BEGIN");
      const result = await client.query<{ hour: Date }>("SELECT date_trunc('hour', now(), 'UTC') AS hour");
      const [row] = result.rows;
      if (row === undefined) throw new Error("SELECT returned no row");
      return row.hour;
    });
    const event = {
      notificationId: "ops-role-check",
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      eventDate: hour,
      publishAttemptCount: 1,
    };
    await step("recordDeletionEvent insert", () => recordDeletionEvent(client, event));
    await step("recordDeletionEvent update", () => recordDeletionEvent(client, event));
    await step("addHourlyCounts", () =>
      addHourlyCounts(client, {
        deletionResults: [{ hourUtc: hour, result: "dropped", count: 1 }],
        apiUsage: [{ hourUtc: hour, resource: "identity.oauth2", purpose: "token", calls: 1 }],
      }),
    );
    await step("recordProbeSeen", () => recordProbeSeen(client, hour));
    const timeout = await step("statement_timeout", async () => {
      const result = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
      return result.rows[0]?.statement_timeout;
    });
    if (timeout !== "2s") throw new AppRoleCheckError(`app role check failed at statement_timeout: ${timeout}`);
  } finally {
    // Nothing is kept. After a failed step that step's error is the one worth throwing.
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

// The message carries the step and the SQLSTATE only: a pg error message can quote values.
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new AppRoleCheckError(`app role check failed at ${name}: ${errorCode(error)}`);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "unknown";
}

// RFC 5803 format, as Postgres builds it: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>.
// The password is hex, which SASLprep leaves unchanged.
function scramVerifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
