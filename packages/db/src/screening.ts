import type { CodeSignal, ProductMatch, Verdict } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

// Section 2.4: one claim row per (item key, prompt version), at most 2 paid attempts.
export const SCREEN_LEASE_MS = 90_000;
export const MAX_SCREEN_ATTEMPTS = 2;

export type ScreeningStatus = "running" | "done" | "failed" | "skipped";

export type ScreeningClaim =
  // Go ahead with the call as this attempt; write the result fenced on it.
  | { kind: "claimed"; id: string; attempt: number }
  // done, failed or skipped earlier: reuse the result.
  | { kind: "finished"; id: string; status: Exclude<ScreeningStatus, "running"> }
  // Another job holds a live lease: exit, relay re-enqueues later if needed.
  | { kind: "busy"; id: string }
  // A stale claim on attempt 2: now failed with attempts_exhausted; alert as not screened.
  | { kind: "exhausted"; id: string };

export type ClaimInput = { itemKey: string; promptVersion: string; model: string; now: Date };

const leaseEnd = (now: Date): Date => new Date(now.getTime() + SCREEN_LEASE_MS);

export async function claimScreening(db: Queryable, input: ClaimInput): Promise<ScreeningClaim> {
  const inserted = await db.query<{ id: string; attempt: number }>(
    `INSERT INTO app.screening (item_key, prompt_version, model, status, attempt, lease_until, created_at, updated_at)
     VALUES ($1, $2, $3, 'running', 1, $4, $5, $5)
     ON CONFLICT (item_key, prompt_version) DO NOTHING
     RETURNING id, attempt`,
    [input.itemKey, input.promptVersion, input.model, leaseEnd(input.now), input.now],
  );
  const fresh = inserted.rows[0];
  if (fresh !== undefined) return { kind: "claimed", id: fresh.id, attempt: fresh.attempt };

  // A lease that ran out, or one a handled failure released: take it over as the next attempt.
  const takenOver = await db.query<{ id: string; attempt: number }>(
    `UPDATE app.screening SET attempt = attempt + 1, lease_until = $3, updated_at = $4
      WHERE item_key = $1 AND prompt_version = $2 AND status = 'running' AND lease_until <= $4 AND attempt < $5
      RETURNING id, attempt`,
    [input.itemKey, input.promptVersion, leaseEnd(input.now), input.now, MAX_SCREEN_ATTEMPTS],
  );
  const next = takenOver.rows[0];
  if (next !== undefined) return { kind: "claimed", id: next.id, attempt: next.attempt };

  const exhausted = await db.query<{ id: string }>(
    `UPDATE app.screening
        SET status = 'failed', failure_code = 'attempts_exhausted', lease_until = NULL, updated_at = $3
      WHERE item_key = $1 AND prompt_version = $2 AND status = 'running' AND lease_until <= $3 AND attempt >= $4
      RETURNING id`,
    [input.itemKey, input.promptVersion, input.now, MAX_SCREEN_ATTEMPTS],
  );
  const stale = exhausted.rows[0];
  if (stale !== undefined) return { kind: "exhausted", id: stale.id };

  const current = await db.query<{ id: string; status: ScreeningStatus }>(
    "SELECT id, status FROM app.screening WHERE item_key = $1 AND prompt_version = $2",
    [input.itemKey, input.promptVersion],
  );
  const row = current.rows[0];
  if (row === undefined) throw new Error("screening claim row vanished");
  if (row.status === "running") return { kind: "busy", id: row.id };
  return { kind: "finished", id: row.id, status: row.status };
}

// What one call cost. Every call that reached Anthropic is recorded, failures included; the
// token, cost and reservation columns add up over the attempts of the claim.
export type ScreeningUsage = {
  requestBytes: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicrousd: number | null;
  reservedMicrousd: number | null;
  latencyMs: number | null;
  inferenceGeo: string | null;
};

const NO_USAGE: ScreeningUsage = {
  requestBytes: null,
  inputTokens: null,
  outputTokens: null,
  costMicrousd: null,
  reservedMicrousd: null,
  latencyMs: null,
  inferenceGeo: null,
};

// SET clauses for the usage parameters starting at $first.
function usageSets(first: number): string {
  const add = (column: string, n: number) =>
    `${column} = CASE WHEN $${n}::integer IS NULL THEN ${column} ELSE coalesce(${column}, 0) + $${n}::integer END`;
  const keep = (column: string, n: number, type: string) => `${column} = coalesce($${n}::${type}, ${column})`;
  return [
    keep("request_bytes", first, "integer"),
    add("input_tokens", first + 1),
    add("output_tokens", first + 2),
    add("cost_microusd", first + 3),
    add("reserved_microusd", first + 4),
    keep("latency_ms", first + 5, "integer"),
    keep("inference_geo", first + 6, "text"),
  ].join(", ");
}

const usageValues = (usage: ScreeningUsage | null): unknown[] => {
  const u = usage ?? NO_USAGE;
  return [u.requestBytes, u.inputTokens, u.outputTokens, u.costMicrousd, u.reservedMicrousd, u.latencyMs, u.inferenceGeo];
};

// A handled, retryable failure on attempt 1 releases the lease at once, so the pg-boss retry
// takes over immediately as attempt 2. Fenced on the attempt: false when another attempt holds it.
export async function releaseScreeningLease(
  db: Queryable,
  input: { id: string; attempt: number; failureCode: string; now: Date; usage: ScreeningUsage | null },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE app.screening
        SET lease_until = $3, failure_code = $4, updated_at = $3, ${usageSets(5)}
      WHERE id = $1 AND attempt = $2 AND status = 'running'`,
    [input.id, input.attempt, input.now, input.failureCode, ...usageValues(input.usage)],
  );
  return result.rowCount === 1;
}

// After auth_failed every listing skips screening for 15 minutes (one row). A shorter pause never
// cuts a longer one.
export async function pauseScreening(db: Queryable, until: Date): Promise<void> {
  await db.query(
    `INSERT INTO app.screening_pause AS p (id, until) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET until = greatest(p.until, EXCLUDED.until)`,
    [until],
  );
}

// The end of the active pause, or null.
export async function screeningPausedUntil(db: Queryable, now: Date): Promise<Date | null> {
  const result = await db.query<{ until: Date }>("SELECT until FROM app.screening_pause WHERE id = 1 AND until > $1", [now]);
  return result.rows[0]?.until ?? null;
}

export type ScreeningResult = {
  id: string;
  attempt: number;
  now: Date;
  status: Exclude<ScreeningStatus, "running">;
  // Set for done, null for failed and skipped.
  verdict: Verdict | null;
  productMatch: ProductMatch | null;
  riskFlags: string[];
  codeSignals: CodeSignal[];
  failureCode: string | null;
  // Claude's reason (listing-derived text): kept in ebay_live.screening_text until reasonExpiresAt.
  reason: string | null;
  reasonExpiresAt: Date | null;
  usage: ScreeningUsage | null;
};

// The result, fenced on the attempt: false when another attempt took over or a result is already
// written. Run it in the result transaction with the decision and the send enqueue.
export async function finishScreening(db: Queryable, result: ScreeningResult): Promise<boolean> {
  const written = await db.query<{ written: number }>(
    `WITH s AS (
       UPDATE app.screening
          SET status = $3, verdict = $4, product_match = $5, risk_flags = $6, code_signals = $7, failure_code = $8,
              lease_until = NULL, updated_at = $9, ${usageSets(12)}
        WHERE id = $1 AND attempt = $2 AND status = 'running'
        RETURNING id
     ),
     t AS (
       INSERT INTO ebay_live.screening_text (screening_id, reason, expires_at)
       SELECT s.id, $10, $11 FROM s WHERE $10::text IS NOT NULL
       ON CONFLICT (screening_id) DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at
     )
     SELECT count(*)::int AS written FROM s`,
    [
      result.id,
      result.attempt,
      result.status,
      result.verdict,
      result.productMatch,
      result.riskFlags,
      result.codeSignals,
      result.failureCode,
      result.now,
      result.reason,
      result.reasonExpiresAt,
      ...usageValues(result.usage),
    ],
  );
  return written.rows[0]?.written === 1;
}

export type Screening = ScreeningUsage & {
  id: string;
  itemKey: string;
  promptVersion: string;
  model: string;
  status: ScreeningStatus;
  attempt: number;
  verdict: Verdict | null;
  productMatch: ProductMatch | null;
  riskFlags: string[];
  codeSignals: CodeSignal[];
  failureCode: string | null;
  // null once the listing content (and with it the reason) expired.
  reason: string | null;
};

export async function getScreening(db: Queryable, id: string): Promise<Screening | null> {
  const result = await db.query<{
    id: string;
    item_key: string;
    prompt_version: string;
    model: string;
    status: ScreeningStatus;
    attempt: number;
    verdict: Verdict | null;
    product_match: ProductMatch | null;
    risk_flags: string[];
    code_signals: CodeSignal[];
    failure_code: string | null;
    reason: string | null;
    request_bytes: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cost_microusd: number | null;
    reserved_microusd: number | null;
    latency_ms: number | null;
    inference_geo: string | null;
  }>(
    `SELECT s.id, s.item_key, s.prompt_version, s.model, s.status, s.attempt, s.verdict, s.product_match, s.risk_flags,
            s.code_signals, s.failure_code, t.reason, s.request_bytes, s.input_tokens, s.output_tokens, s.cost_microusd,
            s.reserved_microusd, s.latency_ms, s.inference_geo
       FROM app.screening s LEFT JOIN ebay_live.screening_text t ON t.screening_id = s.id
      WHERE s.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    itemKey: row.item_key,
    promptVersion: row.prompt_version,
    model: row.model,
    status: row.status,
    attempt: row.attempt,
    verdict: row.verdict,
    productMatch: row.product_match,
    riskFlags: row.risk_flags,
    codeSignals: row.code_signals,
    failureCode: row.failure_code,
    reason: row.reason,
    requestBytes: row.request_bytes,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicrousd: row.cost_microusd,
    reservedMicrousd: row.reserved_microusd,
    latencyMs: row.latency_ms,
    inferenceGeo: row.inference_geo,
  };
}
