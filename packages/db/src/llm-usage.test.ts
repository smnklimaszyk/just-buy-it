import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { llmSlotAvailable, llmUsageForDay, reserveLlmCall, settleLlmCall } from "./llm-usage.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

const WORST = 62_000;
const USD_2 = 2_000_000;

describe("reserveLlmCall", () => {
  it("holds the call cap of 40 under 50 concurrent reservations and names the cap it refused on", async () => {
    const input = { day: "2026-10-21", worstMicrousd: WORST, callLimit: 40, spendLimitMicrousd: 100 * USD_2 };

    const results = await Promise.all(Array.from({ length: 50 }, () => reserveLlmCall(database.pool, input)));

    expect(results.filter((r) => r.ok)).toHaveLength(40);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 10 }, () => ({ ok: false, code: "cap_reached" })));
    expect(await llmUsageForDay(database.pool, "2026-10-21")).toEqual({ calls: 40, reservedMicrousd: 40 * WORST, spentMicrousd: 0 });
    expect(await llmUsageForDay(database.pool, "2026-10-22")).toEqual({ calls: 0, reservedMicrousd: 0, spentMicrousd: 0 });
  });

  it("allows at most 32 worst-case reservations under USD 2 while none settle, and settling at USD 0.01 frees room", async () => {
    const input = { day: "2026-10-23", worstMicrousd: WORST, callLimit: 40, spendLimitMicrousd: USD_2 };

    const results = await Promise.all(Array.from({ length: 40 }, () => reserveLlmCall(database.pool, input)));
    expect(await llmSlotAvailable(database.pool, input, 0)).toBe("spend_cap_reached");
    for (let i = 0; i < 32; i++) {
      await settleLlmCall(database.pool, { day: input.day, worstMicrousd: WORST, actualMicrousd: 10_000 });
    }
    const after = await reserveLlmCall(database.pool, input);

    expect(results.filter((r) => r.ok)).toHaveLength(32);
    expect(new Set(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code)))).toEqual(new Set(["spend_cap_reached"]));
    expect(after).toEqual({ ok: true, calls: 33 });
    expect(await llmUsageForDay(database.pool, input.day)).toEqual({ calls: 33, reservedMicrousd: WORST, spentMicrousd: 320_000 });
    expect(await llmSlotAvailable(database.pool, input, 0)).toBe("ok");
    expect(await llmSlotAvailable(database.pool, { ...input, callLimit: 33 }, 0)).toBe("cap_reached");
    // Screens queued after enrich will each reserve a call: they count as taken.
    expect(await llmSlotAvailable(database.pool, { ...input, callLimit: 34 }, 0)).toBe("ok");
    expect(await llmSlotAvailable(database.pool, { ...input, callLimit: 34 }, 1)).toBe("cap_reached");
    // 320,000 spent + 62,000 reserved: 25 queued screens and this one fit in USD 2, 26 do not.
    expect(await llmSlotAvailable(database.pool, { ...input, callLimit: 100 }, 25)).toBe("ok");
    expect(await llmSlotAvailable(database.pool, { ...input, callLimit: 100 }, 26)).toBe("spend_cap_reached");
    expect(await reserveLlmCall(database.pool, { ...input, day: "2026-10-24", callLimit: 0 })).toEqual({ ok: false, code: "cap_reached" });
    expect(await reserveLlmCall(database.pool, { ...input, day: "2026-10-24", spendLimitMicrousd: 0 })).toEqual({
      ok: false,
      code: "spend_cap_reached",
    });
  });
});
