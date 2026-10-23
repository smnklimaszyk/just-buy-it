import { saveProductWithPlan, type StoredProduct } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createRequestQueuer } from "./requests.js";

const NOW = new Date("2026-10-21T10:00:00.000Z");
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };

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
              app.market_request, app.category_request, app.audit_event CASCADE`,
  );
});

// Synthetic example products (ADR 0023). A create adds a market request "created".
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

type Sent = { name: string; payload: unknown; inTransaction: boolean };

// Keeps what is sent instead of writing pg-boss jobs. `answer` stands in for the exclusive queue:
// null when a job for the key is already queued or running.
function recordingQueue(answer: (payload: unknown) => string | null = () => "job") {
  const sent: Sent[] = [];
  const queue: Pick<JobQueue, "send"> = {
    async send(name, payload, options) {
      sent.push({ name, payload, inTransaction: options?.db !== undefined });
      return answer(payload);
    },
  };
  return { sent, queue };
}

async function requestStatuses(): Promise<{ product_id: string; status: string }[]> {
  const result = await db.admin.query<{ product_id: string; status: string }>(
    "SELECT product_id, status FROM app.market_request ORDER BY requested_at, id",
  );
  return result.rows;
}

describe("createRequestQueuer, market requests (spec 6.3)", () => {
  it("turns each open market request into a market-snapshot job, sent in the transaction that marks it queued", async () => {
    const lens = await createProduct();
    const bike = await createProduct({ name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const { sent, queue } = recordingQueue();

    await createRequestQueuer({ pool: db.pool, queue })(NOW);

    expect(sent).toEqual([
      { name: "market-snapshot", payload: { productId: lens.id }, inTransaction: true },
      { name: "market-snapshot", payload: { productId: bike.id }, inTransaction: true },
    ]);
    expect(await requestStatuses()).toEqual([
      { product_id: lens.id, status: "queued" },
      { product_id: bike.id, status: "queued" },
    ]);
  });

  it("leaves a request open while the product's snapshot job is still queued or running, and queues it on a later tick", async () => {
    const lens = await createProduct();
    const busy = recordingQueue(() => null);

    await createRequestQueuer({ pool: db.pool, queue: busy.queue })(NOW);
    expect(await requestStatuses()).toEqual([{ product_id: lens.id, status: "open" }]);

    const free = recordingQueue();
    await createRequestQueuer({ pool: db.pool, queue: free.queue })(NOW);
    expect(free.sent).toEqual([{ name: "market-snapshot", payload: { productId: lens.id }, inTransaction: true }]);
    expect(await requestStatuses()).toEqual([{ product_id: lens.id, status: "queued" }]);

    await createRequestQueuer({ pool: db.pool, queue: free.queue })(NOW);
    expect(free.sent).toHaveLength(1);
  });
});

describe("createRequestQueuer, a snapshot that died while running", () => {
  it("queues again a request left running by a crash once its run is older than the job's 150 s, and not before", async () => {
    const lens = await createProduct();
    await db.admin.query("UPDATE app.market_request SET status = 'running' WHERE product_id = $1", [lens.id]);
    await db.admin.query("INSERT INTO app.market_run (product_id, started_at) VALUES ($1, $2)", [lens.id, new Date(NOW.getTime() - 100_000)]);
    const { sent, queue } = recordingQueue();

    await createRequestQueuer({ pool: db.pool, queue })(NOW);
    expect(await requestStatuses(), "100 s after the run started").toEqual([{ product_id: lens.id, status: "running" }]);

    await createRequestQueuer({ pool: db.pool, queue })(new Date(NOW.getTime() + 60_000));
    expect(sent).toEqual([{ name: "market-snapshot", payload: { productId: lens.id }, inTransaction: true }]);
    expect(await requestStatuses(), "160 s after the run started").toEqual([{ product_id: lens.id, status: "queued" }]);
  });
});

describe("createRequestQueuer, category requests (spec 6.6)", () => {
  it("turns each open category request into a category-suggest job and marks it queued", async () => {
    const inserted = await db.admin.query<{ id: string }>(
      `INSERT INTO app.category_request (q, status, done_at)
       VALUES ('rennrad', 'open', NULL), ('(85mm,portraitobjektiv)', 'done', now()) RETURNING id`,
    );
    const { sent, queue } = recordingQueue();

    await createRequestQueuer({ pool: db.pool, queue })(NOW);

    const open = inserted.rows[0]?.id;
    expect(sent).toEqual([{ name: "category-suggest", payload: { requestId: open }, inTransaction: true }]);
    const statuses = await db.admin.query<{ id: string; status: string }>("SELECT id, status FROM app.category_request ORDER BY q DESC");
    expect(statuses.rows).toEqual([
      { id: open, status: "queued" },
      { id: inserted.rows[1]?.id, status: "done" },
    ]);
  });
});
