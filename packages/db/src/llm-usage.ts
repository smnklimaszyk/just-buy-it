import type { Queryable } from "./pool.js";

// Section 5.5: Claude calls and spend per Berlin day. `day` is the Berlin date, YYYY-MM-DD.

export type LlmCapCode = "cap_reached" | "spend_cap_reached";

export type LlmReservationInput = {
  day: string;
  // The worst-case cost of one call (USD 0.062 = 62,000 micro-USD with screen-v1).
  worstMicrousd: number;
  callLimit: number;
  spendLimitMicrousd: number;
};

export type LlmReservation = { ok: true; calls: number } | { ok: false; code: LlmCapCode };

export type LlmUsage = { calls: number; reservedMicrousd: number; spentMicrousd: number };

// Both caps in one statement: a call is reserved only while the day has a call left and spent +
// reserved + one more worst case stays within the spend limit. Retries count; no refunds.
export async function reserveLlmCall(db: Queryable, input: LlmReservationInput): Promise<LlmReservation> {
  const result = await db.query<{ calls: number }>(
    `INSERT INTO app.llm_usage_daily AS u (day_berlin, calls, reserved_microusd, spent_microusd)
     SELECT $1::date, 1, $2::bigint, 0 WHERE $3::integer >= 1 AND $2::bigint <= $4::bigint
     ON CONFLICT (day_berlin) DO UPDATE
       SET calls = u.calls + 1, reserved_microusd = u.reserved_microusd + $2::bigint
       WHERE u.calls < $3::integer
         AND u.spent_microusd + u.reserved_microusd + $2::bigint <= $4::bigint
     RETURNING u.calls`,
    [input.day, input.worstMicrousd, input.callLimit, input.spendLimitMicrousd],
  );
  const row = result.rows[0];
  if (row !== undefined) return { ok: true, calls: row.calls };
  return { ok: false, code: refusalCode(input, await llmUsageForDay(db, input.day)) };
}

function refusalCode(input: LlmReservationInput, usage: LlmUsage): LlmCapCode {
  if (input.callLimit < 1 || usage.calls >= input.callLimit) return "cap_reached";
  return "spend_cap_reached";
}

// Read-only check before getItem (section 2.4): does the day leave room for one worst-case call
// under both caps, after the `inFlight` screens that are queued or running but have not reserved
// yet? The reservation itself happens before the Claude call.
export async function llmSlotAvailable(db: Queryable, input: LlmReservationInput, inFlight: number): Promise<"ok" | LlmCapCode> {
  const usage = await llmUsageForDay(db, input.day);
  if (input.callLimit < 1 || usage.calls + inFlight >= input.callLimit) return "cap_reached";
  const worstCases = (inFlight + 1) * input.worstMicrousd;
  if (usage.spentMicrousd + usage.reservedMicrousd + worstCases > input.spendLimitMicrousd) return "spend_cap_reached";
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
