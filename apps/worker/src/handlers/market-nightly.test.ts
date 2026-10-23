import { saveProductWithPlan, type StoredProduct } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createTestLog } from "../testing/log.js";
import { createMarketNightlyHandler } from "./market-nightly.js";

const NOW = new Date("2026-10-22T01:00:00.000Z");
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };
const job = { id: "nightly-1", retryCount: 0, signal: new AbortController().signal };

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.admin.query(
    `TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting,
              app.market_request, app.audit_event CASCADE`,
  );
});

// Synthetic example products (ADR 0023).
async function createProduct(overrides: Record<string, unknown> = {}): Promise<StoredProduct> {
  const fields = {
    name: "Portrait lens",
    description: "An 85 mm portrait lens for a full-frame camera.",
    status: "draft",
    categoryId: "3323",
    conditionIds: ["3000"],
    searchWords: ["85mm"],
    mustWords: [["85mm"]],
    priceMode: "fixed",
    maxCents: 30_000,
    buyerProfile: "private",
    ...overrides,
  };
  const result = await saveProductWithPlan(
    db.admin,
    { kind: "create", fields },
    { at: NOW, actor: "system:cli", userId: null, env: SETTINGS_ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.product;
}

function recordingQueue(answer: () => string | null = () => "job") {
  const sent: { name: string; payload: unknown }[] = [];
  const queue: Pick<JobQueue, "send"> = {
    async send(name, payload) {
      sent.push({ name, payload });
      return answer();
    },
  };
  return { sent, queue };
}

describe("market-nightly handler (spec 6.3)", () => {
  it("queues one market-snapshot job per non-archived product with an eBay source, drafts and paused ones included", async () => {
    const draft = await createProduct();
    const active = await createProduct({ name: "Road bike", status: "active", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const paused = await createProduct({ name: "Espresso machine", status: "paused", categoryId: "38252", searchWords: ["siebträger"], mustWords: [["siebträger"]] });
    const archived = await createProduct({ name: "Pram", categoryId: "66700", searchWords: ["kinderwagen"], mustWords: [["kinderwagen"]] });
    const noEbay = await createProduct({ name: "Lego set", categoryId: "19006", searchWords: ["10305"], mustWords: [["10305"]] });
    await db.admin.query("UPDATE app.product SET status = 'archived' WHERE id = $1", [archived.id]);
    await db.admin.query("UPDATE app.product_source SET enabled = false WHERE product_id = $1 AND source = 'ebay'", [noEbay.id]);
    const { sent, queue } = recordingQueue();
    const log = createTestLog();

    await createMarketNightlyHandler({ pool: db.pool, queue, log: log.log })({}, job);

    expect(sent.map((s) => s.name)).toEqual(["market-snapshot", "market-snapshot", "market-snapshot"]);
    expect(new Set(sent.map((s) => s.payload))).toEqual(
      new Set([{ productId: draft.id }, { productId: active.id }, { productId: paused.id }]),
    );
    expect(log.events("market_nightly")).toEqual([{ event: "market_nightly", products: 3, queued: 3 }]);
  });
});
