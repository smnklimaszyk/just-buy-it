import type { Queryable } from "./pool.js";

export type WorkerStatus = {
  gitSha: string;
  startedAt: Date;
  heartbeatAt: Date;
  smtpConfigured: boolean;
  claudeConfigured: boolean;
};

// At worker start (section 2.6): one row, overwritten; the heartbeat starts at the start time.
export async function upsertWorkerStatus(db: Queryable, status: Omit<WorkerStatus, "heartbeatAt">): Promise<void> {
  await db.query(
    `INSERT INTO app.worker_status (id, git_sha, started_at, heartbeat_at, smtp_configured, claude_configured)
     VALUES (1, $1, $2, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       git_sha = EXCLUDED.git_sha, started_at = EXCLUDED.started_at, heartbeat_at = EXCLUDED.heartbeat_at,
       smtp_configured = EXCLUDED.smtp_configured, claude_configured = EXCLUDED.claude_configured`,
    [status.gitSha, status.startedAt, status.smtpConfigured, status.claudeConfigured],
  );
}

// Every 10 s. A late write with an older time never moves heartbeat_at back.
export async function recordHeartbeat(db: Queryable, at: Date): Promise<void> {
  await db.query("UPDATE app.worker_status SET heartbeat_at = greatest(heartbeat_at, $1) WHERE id = 1", [at]);
}

export async function getWorkerStatus(db: Queryable): Promise<WorkerStatus | null> {
  const result = await db.query<{
    git_sha: string;
    started_at: Date;
    heartbeat_at: Date;
    smtp_configured: boolean;
    claude_configured: boolean;
  }>("SELECT git_sha, started_at, heartbeat_at, smtp_configured, claude_configured FROM app.worker_status WHERE id = 1");
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    gitSha: row.git_sha,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    smtpConfigured: row.smtp_configured,
    claudeConfigured: row.claude_configured,
  };
}
