import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { saveProductWithPlan } from "./config-store.js";
import { llmSlotAvailable, llmUsageForDay, reserveLlmCall, settleLlmCall } from "./llm-usage.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;
// The worker reserves Claude calls; its grants must be enough (spec 2.10).
let worker: pg.Pool;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
  worker = new pg.Pool({ connectionString: database.url, max: 30, options: "-c role=worker" });
});

afterAll(async () => {
  await worker.end();
  await database.drop();
});

const WORST = 62_000;
const USD_2 = 2_000_000;

const ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: USD_2, buyerProfile: null };

// Synthetic example products (ADR 0023), each in its own category.
async function createProduct(name: string, categoryId: string, status = "active"): Promise<string> {
  const result = await saveProductWithPlan(
    database.pool,
    {
      kind: "create",
      fields: {
        name,
        description: `A used ${name.toLowerCase()}.`,
        status,
        categoryId,
        conditionIds: ["3000"],
        searchWords: [name.toLowerCase().replaceAll(" ", "")],
        mustWords: [[name.toLowerCase().replaceAll(" ", "")]],
        priceMode: "fixed",
        maxCents: 50_000,
        buyerProfile: "private",
      },
    },
    { at: new Date("2026-10-20T08:00:00.000Z"), actor: "system:cli", userId: null, env: ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.product.key;
}

describe("reserveLlmCall", () => {
  it("holds the call cap of 40 under 50 concurrent reservations and names the cap it refused on", async () => {
    const input = { day: "2026-10-21", worstMicrousd: WORST, callLimit: 40, spendLimitMicrousd: 100 * USD_2, productKey: null };

    const results = await Promise.all(Array.from({ length: 50 }, () => reserveLlmCall(database.pool, input)));

    expect(results.filter((r) => r.ok)).toHaveLength(40);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 10 }, () => ({ ok: false, code: "cap_reached" })));
    expect(await llmUsageForDay(database.pool, "2026-10-21")).toEqual({ calls: 40, reservedMicrousd: 40 * WORST, spentMicrousd: 0 });
    expect(await llmUsageForDay(database.pool, "2026-10-22")).toEqual({ calls: 0, reservedMicrousd: 0, spentMicrousd: 0 });
  });

  it("allows at most 32 worst-case reservations under USD 2 while none settle, and settling at USD 0.01 frees room", async () => {
    const input = { day: "2026-10-23", worstMicrousd: WORST, callLimit: 40, spendLimitMicrousd: USD_2, productKey: null };

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

describe("reserveLlmCall, the per-product share (spec 4.4)", () => {
  it("refuses the 21st call of one product with a call limit of 40 while two products are active", async () => {
    const lens = await createProduct("Portrait lens", "3323");
    const bike = await createProduct("Road bike", "177831");
    const input = (productKey: string) => ({
      day: "2026-10-25",
      worstMicrousd: WORST,
      callLimit: 40,
      spendLimitMicrousd: 100 * USD_2,
      productKey,
    });

    const results = await Promise.all(Array.from({ length: 25 }, () => reserveLlmCall(worker, input(lens))));

    expect(results.filter((r) => r.ok)).toHaveLength(20);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 5 }, () => ({ ok: false, code: "product_share_reached" })));
    // A refused share takes no call of the day.
    expect(await llmUsageForDay(database.pool, "2026-10-25")).toEqual({ calls: 20, reservedMicrousd: 20 * WORST, spentMicrousd: 0 });
    // The other product still gets its calls.
    expect(await reserveLlmCall(worker, input(bike))).toEqual({ ok: true, calls: 21 });
    const shares = await database.pool.query(
      "SELECT product_key, calls FROM app.llm_usage_product_daily WHERE day_berlin = '2026-10-25' ORDER BY calls DESC",
    );
    expect(shares.rows).toEqual([
      { product_key: lens, calls: 20 },
      { product_key: bike, calls: 1 },
    ]);
  });

  it("tells enrich before getItem that a product has used its share, so no getItem is made for a check that cannot run", async () => {
    const tripod = await createProduct("Tripod", "30090");
    const flash = await createProduct("Flash", "48515");
    const input = (productKey: string) => ({
      day: "2026-10-27",
      worstMicrousd: WORST,
      callLimit: 4,
      spendLimitMicrousd: 100 * USD_2,
      productKey,
    });
    await reserveLlmCall(worker, input(tripod));
    await reserveLlmCall(worker, input(tripod));

    expect(await llmSlotAvailable(worker, input(tripod), 0), "tripod after 2 of 4 calls").toBe("product_share_reached");
    expect(await llmSlotAvailable(worker, input(flash), 0), "flash").toBe("ok");
  });

  it("applies no share while only one product is active, but still counts its calls", async () => {
    await database.pool.query("UPDATE app.product SET status = 'paused'");
    const espresso = await createProduct("Espresso machine", "38252");
    const input = { day: "2026-10-26", worstMicrousd: WORST, callLimit: 40, spendLimitMicrousd: 100 * USD_2, productKey: espresso };

    const results = await Promise.all(Array.from({ length: 30 }, () => reserveLlmCall(worker, input)));

    expect(results.filter((r) => r.ok)).toHaveLength(30);
    const shares = await database.pool.query("SELECT calls FROM app.llm_usage_product_daily WHERE day_berlin = '2026-10-26'");
    expect(shares.rows).toEqual([{ calls: 30 }]);
  });
});
