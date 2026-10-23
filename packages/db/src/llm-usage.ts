import type pg from "pg";
import type { DbPool, Queryable } from "./pool.js";

// Section 5.5: Claude calls and spend per Berlin day. `day` is the Berlin date, YYYY-MM-DD.

export type LlmCapCode = "cap_reached" | "spend_cap_reached" | "product_share_reached";

export type LlmReservationInput = {
  day: string;
  // The worst-case cost of one call on the chosen model (models.ts in packages/llm).
  worstMicrousd: number;
  // The effective caps, min(setting, .env ceiling), read when the call is made (spec 4.4).
  callLimit: number;
  spendLimitMicrousd: number;
  // The candidate's product key, counted against its share of the calls; null counts no share.
  productKey: string | null;
};

export type LlmReservation = { ok: true; calls: number } | { ok: false; code: LlmCapCode };

export type LlmUsage = { calls: number; reservedMicrousd: number; spentMicrousd: number };

const DAILY_RESERVATION = `INSERT INTO app.llm_usage_daily AS u (day_berlin, calls, reserved_microusd, spent_microusd)
     SELECT $1::date, 1, $2::bigint, 0 WHERE $3::integer >= 1 AND $2::bigint <= $4::bigint
     ON CONFLICT (day_berlin) DO UPDATE
       SET calls = u.calls + 1, reserved_microusd = u.reserved_microusd + $2::bigint
       WHERE u.calls < $3::integer
         AND u.spent_microusd + u.reserved_microusd + $2::bigint <= $4::bigint
     RETURNING u.calls`;

// Spec 4.4: while two or more products are active, one product gets at most half of the day's
// calls, rounded up. With fewer active products the row only counts.
const PRODUCT_SHARE = `WITH share AS (
       SELECT CASE WHEN (SELECT count(*) FROM app.product WHERE status = 'active') >= 2
                   THEN ceil($3::integer / 2.0)::integer END AS max_calls
     )
     INSERT INTO app.llm_usage_product_daily AS p (day_berlin, product_key, calls)
     SELECT $1::date, $2::text, 1 FROM share WHERE share.max_calls IS NULL OR share.max_calls >= 1
     ON CONFLICT (day_berlin, product_key) DO UPDATE SET calls = p.calls + 1
       WHERE (SELECT max_calls FROM share) IS NULL OR p.calls < (SELECT max_calls FROM share)
     RETURNING p.calls`;

// Both caps and the product's share in one transaction: a call is reserved only while the day has
// a call left, spent + reserved + one more worst case stays within the spend limit, and the
// product is within its share. The daily row is locked first, so parallel reservations queue on
// it and the share is counted exactly. Retries count; no refunds.
export async function reserveLlmCall(pool: DbPool, input: LlmReservationInput): Promise<LlmReservation> {
  const client = await pool.connect();
  let code: LlmCapCode | null;
  let calls: number;
  try {
    await client.query("BEGIN");
    const daily = await client.query<{ calls: number }>(DAILY_RESERVATION, [
      input.day,
      input.worstMicrousd,
      input.callLimit,
      input.spendLimitMicrousd,
    ]);
    code = daily.rows[0] === undefined ? "cap_reached" : await shareRefusal(client, input);
    calls = daily.rows[0]?.calls ?? 0;
    await client.query(code === null ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (code === null) return { ok: true, calls };
  if (code === "product_share_reached") return { ok: false, code };
  return { ok: false, code: refusalCode(input, await llmUsageForDay(pool, input.day)) };
}

async function shareRefusal(client: pg.PoolClient, input: LlmReservationInput): Promise<LlmCapCode | null> {
  if (input.productKey === null) return null;
  const share = await client.query(PRODUCT_SHARE, [input.day, input.productKey, input.callLimit]);
  return share.rowCount === 1 ? null : "product_share_reached";
}

// The day and both caps, without the product share.
export type LlmDayCaps = Omit<LlmReservationInput, "productKey">;

function refusalCode(input: LlmDayCaps, usage: LlmUsage): LlmCapCode {
  if (input.callLimit < 1 || usage.calls >= input.callLimit) return "cap_reached";
  return "spend_cap_reached";
}

// Read-only check before getItem (section 2.4): does the day leave room for one worst-case call
// under both caps, after the `inFlight` screens that are queued or running but have not reserved
// yet, and is the product within its share (spec 4.4)? The reservation itself happens before the
// Claude call.
export async function llmSlotAvailable(db: Queryable, input: LlmReservationInput, inFlight: number): Promise<"ok" | LlmCapCode> {
  const usage = await llmUsageForDay(db, input.day);
  if (input.callLimit < 1 || usage.calls + inFlight >= input.callLimit) return "cap_reached";
  const worstCases = (inFlight + 1) * input.worstMicrousd;
  if (usage.spentMicrousd + usage.reservedMicrousd + worstCases > input.spendLimitMicrousd) return "spend_cap_reached";
  if (input.productKey !== null) {
    const share = await db.query<{ used: boolean }>(
      `SELECT (SELECT count(*) FROM app.product WHERE status = 'active') >= 2
                AND coalesce((SELECT calls FROM app.llm_usage_product_daily WHERE day_berlin = $1::date AND product_key = $2), 0)
                    >= ceil($3::integer / 2.0) AS used`,
      [input.day, input.productKey, input.callLimit],
    );
    if (share.rows[0]?.used === true) return "product_share_reached";
  }
  return "ok";
}

// After the call, on the reservation's day: the worst case leaves the reservation and the actual
// cost is spent. Without usage from the response (timeout, network error after sending) the
// caller passes the worst case, because the request may have been billed.
export async function settleLlmCall(
  db: Queryable,
  input: { day: string; worstMicrousd: number; actualMicrousd: number },
): Promise<void> {
  await db.query(
    `UPDATE app.llm_usage_daily
        SET reserved_microusd = greatest(reserved_microusd - $2::bigint, 0),
            spent_microusd = spent_microusd + $3::bigint
      WHERE day_berlin = $1::date`,
    [input.day, input.worstMicrousd, input.actualMicrousd],
  );
}

export async function llmUsageForDay(db: Queryable, day: string): Promise<LlmUsage> {
  const result = await db.query<{ calls: number; reserved: string; spent: string }>(
    "SELECT calls, reserved_microusd AS reserved, spent_microusd AS spent FROM app.llm_usage_daily WHERE day_berlin = $1::date",
    [day],
  );
  const row = result.rows[0];
  if (row === undefined) return { calls: 0, reservedMicrousd: 0, spentMicrousd: 0 };
  // bigint arrives as text from node-pg.
  return { calls: row.calls, reservedMicrousd: Number(row.reserved), spentMicrousd: Number(row.spent) };
}
