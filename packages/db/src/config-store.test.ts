import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  loadProduct,
  loadSettings,
  previewPlan,
  saveProductWithPlan,
  saveSettings,
  type ConfigContext,
  type ProductSaveResult,
  type StoredProduct,
} from "./config-store.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query(
    "TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting, app.market_request, app.audit_event, auth.app_user CASCADE",
  );
});

const ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };
const T0 = new Date("2026-10-22T08:00:00.000Z");
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const cli = (at = T0, env = ENV): ConfigContext => ({ at, actor: "system:cli", userId: null, env });

// The (model, effort) pairs packages/llm lists as passed for the current prompt.
const EVALS = [
  { model: "claude-sonnet-5-5", effort: "medium" },
  { model: "claude-haiku-4-5", effort: "low" },
];

// A fast product in its own category costs 528 polls + 10 overflow + 3 market calls = 541 a day.
// The fixed part with a Claude call limit of 40: 126 getItem + 60 extra snapshots = 186.
function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Road bike",
    description: "A used road bike, frame size 56.",
    status: "active",
    categoryId: "100001",
    conditionIds: ["3000"],
    searchWords: ["rennrad"],
    mustWords: [["rennrad"]],
    priceMode: "fixed",
    maxCents: 80_000,
    buyerProfile: "private",
    speed: "fast",
    ...overrides,
  };
}

function saved(result: ProductSaveResult): StoredProduct {
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.product;
}

async function create(overrides: Record<string, unknown> = {}, ctx = cli()): Promise<StoredProduct> {
  return saved(await saveProductWithPlan(database.pool, { kind: "create", fields: fields(overrides) }, ctx));
}

async function update(
  product: StoredProduct,
  overrides: Record<string, unknown>,
  ctx = cli(),
): Promise<ProductSaveResult> {
  return saveProductWithPlan(
    database.pool,
    { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, ...overrides } },
    ctx,
  );
}

async function addPerson(email: string, status: "active" | "disabled" = "active"): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    "INSERT INTO auth.app_user (email, role, status, disabled_at) VALUES ($1, 'editor', $2, $3) RETURNING id",
    [email, status, status === "disabled" ? T0 : null],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no person inserted");
  return id;
}

async function count(table: string, where = "true"): Promise<number> {
  const result = await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return result.rows[0]?.n ?? -1;
}

async function auditRows(): Promise<{ actor: string; action: string; detail: Record<string, unknown> }[]> {
  const result = await database.pool.query<{ actor: string; action: string; detail: Record<string, unknown> }>(
    "SELECT actor, action, detail FROM app.audit_event ORDER BY id",
  );
  return result.rows;
}

describe("saveProductWithPlan", () => {
  it("writes the product, its eBay source, the revision, the audit row, the search and a market request in one save", async () => {
    const result = await saveProductWithPlan(database.pool, { kind: "create", fields: fields() }, cli());

    expect(result).toMatchObject({ ok: true, plan: { total: 727, ok: true } });
    const product = saved(result);
    expect(product).toMatchObject({ version: 1, matchVersion: 1, watchFrom: T0, ebayEnabled: true, updatedBy: null });
    expect(product.key).toMatch(/^p_[a-z2-7]{10}$/);
    expect(product.rules).toMatchObject({ name: "Road bike", searchWords: ["rennrad"], candidateCapPerDay: 10 });
    expect(await loadProduct(database.pool, product.key)).toEqual(product);

    const revision = await database.pool.query<{ version: number; actor: string; rules: Record<string, unknown> }>(
      "SELECT version, actor, rules FROM app.product_revision WHERE product_id = $1",
      [product.id],
    );
    expect(revision.rows).toEqual([
      { version: 1, actor: "system:cli", rules: expect.objectContaining({ key: product.key, maxCents: 80_000, matchVersion: 1 }) },
    ]);
    expect(await auditRows()).toEqual([
      { actor: "system:cli", action: "product.created", detail: expect.objectContaining({ key: product.key }) },
    ]);
    const search = await database.pool.query<{ id: string; q: string; category_id: string; members: string[] }>(
      "SELECT s.id, s.q, s.category_id, array_agg(sp.product_id::text) AS members FROM app.search s JOIN app.search_product sp ON sp.search_id = s.id GROUP BY s.id",
    );
    expect(search.rows).toEqual([{ id: expect.stringMatching(/^s[0-9]+$/), q: "rennrad", category_id: "100001", members: [product.id] }]);
    const requests = await database.pool.query("SELECT reason, status, requested_at FROM app.market_request");
    expect(requests.rows).toEqual([{ reason: "created", status: "open", requested_at: T0 }]);
  });

  it("leaves nothing behind when a write late in the save fails", async () => {
    // The revision and the audit row refuse this actor, after the product row was written.
    const ctx = { ...cli(), actor: "System:cli" };

    await expect(saveProductWithPlan(database.pool, { kind: "create", fields: fields() }, ctx)).rejects.toMatchObject({
      code: "23514",
    });

    for (const table of ["app.product", "app.product_source", "app.product_revision", "app.search", "app.search_product", "app.market_request", "app.audit_event"]) {
      expect(await count(table), table).toBe(0);
    }
  });

  it("lets exactly one of two concurrent saves through when each fits but both together exceed 2,500", async () => {
    // 186 + 3 x 541 = 1,809; a fourth makes 2,350, a fifth 2,891.
    for (const categoryId of ["100001", "100002", "100003"]) {
      saved(await saveProductWithPlan(database.pool, { kind: "create", fields: fields({ categoryId }) }, cli()));
    }

    const results = await Promise.all(
      ["100004", "100005"].map((categoryId) =>
        saveProductWithPlan(database.pool, { kind: "create", fields: fields({ categoryId }) }, cli()),
      ),
    );

    expect(results.filter((result) => result.ok)).toEqual([expect.objectContaining({ plan: expect.objectContaining({ total: 2_350 }) })]);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "over_budget", plan: expect.objectContaining({ total: 2_891, ceiling: 2_500, ok: false }) },
    ]);
    expect(await count("app.product")).toBe(4);
    expect(await count("app.search", "retired_at IS NULL")).toBe(4);
    expect(await count("app.search_product")).toBe(4);
    expect(await count("app.audit_event", "action = 'product.created'")).toBe(4);
  });

  it("refuses a stale version, also for an edit of only the cap, and names who changed it", async () => {
    const editor = await addPerson("editor@example.com");
    const product = await create();
    const asEditor: ConfigContext = { ...cli(minutes(1)), actor: `user:${editor}`, userId: editor };
    const first = await update(product, { maxCents: 75_000 }, asEditor);
    expect(first).toMatchObject({ ok: true, product: { version: 2, updatedBy: editor } });

    // A second form still holds version 1.
    const cap = await update(product, { maxCents: 70_000 }, cli(minutes(2)));
    const dailyCap = await update(product, { candidateCapPerDay: 5 }, cli(minutes(2)));

    const conflict = { ok: false, reason: "conflict", changedBy: "editor@example.com", changedAt: minutes(1) };
    expect(cap).toEqual(conflict);
    expect(dailyCap).toEqual(conflict);
    expect((await loadProduct(database.pool, product.key))?.rules).toMatchObject({ maxCents: 75_000, candidateCapPerDay: 10 });
    expect(await count("app.product_revision")).toBe(2);
  });

  it("names the actor of the last revision when no person changed it, and refuses a product that does not exist", async () => {
    const product = await create();
    saved(await update(product, { maxCents: 75_000 }, { ...cli(minutes(1)), actor: "system:import" }));

    expect(await update(product, { maxCents: 70_000 })).toEqual({
      ok: false,
      reason: "conflict",
      changedBy: "system:import",
      changedAt: minutes(1),
    });
    expect(await update({ ...product, id: "0190f0e2-0000-7000-8000-000000000001" }, {})).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("gives two creates in the same second different keys, retrying when a random key is taken", async () => {
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.key).toMatch(/^p_[a-z2-7]{10}$/);
    expect(b.key).toMatch(/^p_[a-z2-7]{10}$/);
    expect(a.key).not.toBe(b.key);

    const taken = Buffer.from("00112233445566", "hex");
    let calls = 0;
    const twice = (size: number): Uint8Array => {
      calls += 1;
      return calls <= 2 ? taken : randomBytes(size);
    };
    const first = saved(await saveProductWithPlan(database.pool, { kind: "create", fields: fields() }, cli(), { keyBytes: twice }));
    const second = saved(await saveProductWithPlan(database.pool, { kind: "create", fields: fields() }, cli(), { keyBytes: twice }));
    expect(calls).toBe(3);
    expect(second.key).not.toBe(first.key);
    expect(await count("app.audit_event")).toBe(4);
  });

  it("gives up after 3 retries with a taken key and writes nothing", async () => {
    const taken = Buffer.from("00112233445566", "hex");
    saved(await saveProductWithPlan(database.pool, { kind: "create", fields: fields() }, cli(), { keyBytes: () => taken }));
    let calls = 0;
    const always = (): Uint8Array => {
      calls += 1;
      return taken;
    };

    await expect(
      saveProductWithPlan(database.pool, { kind: "create", fields: fields() }, cli(), { keyBytes: always }),
    ).rejects.toMatchObject({ code: "23505", constraint: "product_key_unique" });
    expect(calls).toBe(4);
    expect(await count("app.product")).toBe(1);
    expect(await count("app.audit_event")).toBe(1);
  });

  it("keeps a given key, as the legacy import passes it, and refuses it when it is taken or malformed", async () => {
    const imported = saved(
      await saveProductWithPlan(
        database.pool,
        { kind: "create", key: "gpu_3090", fields: fields() },
        { ...cli(), actor: "system:import" },
      ),
    );
    const again = await saveProductWithPlan(database.pool, { kind: "create", key: "gpu_3090", fields: fields() }, cli());
    const bad = await saveProductWithPlan(database.pool, { kind: "create", key: "GPU 3090", fields: fields() }, cli());

    expect(imported.key).toBe("gpu_3090");
    expect(again).toEqual({ ok: false, reason: "invalid", issues: [{ path: ["key"], message: "A product with this key exists." }] });
    expect(bad).toEqual({
      ok: false,
      reason: "invalid",
      issues: [{ path: ["key"], message: "Use 2 to 40 lowercase letters, digits or _, starting with a letter." }],
    });
    expect(await count("app.product")).toBe(1);
  });

  it("bumps match_version for a matching edit and adds one market request, never a second open one", async () => {
    const product = await create({ status: "draft" });
    await database.pool.query("UPDATE app.market_request SET status = 'done', done_at = $1", [T0]);

    const must = saved(await update(product, { mustWords: [["rennrad"], ["carbon"]] }, cli(minutes(1))));
    expect(must).toMatchObject({ version: 2, matchVersion: 2 });
    expect(await count("app.market_request", "status = 'open' AND reason = 'rules_changed'")).toBe(1);

    const exclude = saved(await update(must, { excludeWords: ["defekt"] }, cli(minutes(2))));
    expect(exclude).toMatchObject({ version: 3, matchVersion: 3 });
    expect(await count("app.market_request")).toBe(2);

    const other = saved(await update(exclude, { maxCents: 70_000, warnWords: ["riss"], name: "Racing bike" }, cli(minutes(3))));
    expect(other).toMatchObject({ version: 4, matchVersion: 3 });
    expect(await count("app.market_request")).toBe(2);
  });

  it("treats exactly the matching fields of spec 2.1 as matching, and a reordered list as no change", async () => {
    const matching: Record<string, unknown>[] = [
      { searchWords: ["rennrad", "roadbike"] },
      { mustWords: [["rennrad", "roadbike"]] },
      { excludeWords: ["defekt"] },
      { useDefaultJunk: false },
      { junkExceptions: ["rental"] },
      { accessoryCheck: false },
      { categoryId: "100099" },
      { conditionIds: ["3000", "2750"] },
      { perGb: true, unitMinTotal: 16 },
    ];
    const other: Record<string, unknown>[] = [
      { warnWords: ["riss"] },
      { maxCents: 70_000 },
      { floorCents: 10_000 },
      { name: "Racing bike" },
      { description: "A racing bike." },
      { speed: "slow" },
      { priceDropCheck: true },
      { candidateCapPerDay: 3 },
      { claudeRequired: true },
      { buyerProfile: "company" },
      { priceMode: "below_market", belowMarketPct: 15 },
    ];

    for (const change of matching) {
      const product = await create({ status: "draft" });
      expect(saved(await update(product, change)).matchVersion, JSON.stringify(change)).toBe(2);
    }
    for (const change of other) {
      const product = await create({ status: "draft" });
      expect(saved(await update(product, change)).matchVersion, JSON.stringify(change)).toBe(1);
    }
    const perGb = saved(await update(await create({ status: "draft" }), { perGb: true, unitMinTotal: 16 }));
    expect(saved(await update(perGb, { unitMinTotal: 32 })).matchVersion).toBe(3);
    const words = await create({ status: "draft", searchWords: ["rennrad", "roadbike"], mustWords: [["rennrad", "roadbike"]] });
    const reordered = saved(await update(words, { searchWords: ["roadbike", "rennrad"], mustWords: [["roadbike", "rennrad"]] }));
    expect(reordered).toMatchObject({ version: 1, matchVersion: 1 });
  });

  it("sets watch_from on first activation and otherwise only for search, category or condition edits", async () => {
    let product = await create({}, cli(T0));
    expect(product.watchFrom).toEqual(T0);

    const unchanged: [number, Record<string, unknown>][] = [
      [1, { mustWords: [["rennrad"], ["carbon"]] }],
      [2, { maxCents: 70_000 }],
      [3, { excludeWords: ["defekt"] }],
      [4, { speed: "slow" }],
    ];
    for (const [at, change] of unchanged) {
      product = saved(await update(product, change, cli(minutes(at))));
      expect(product.watchFrom, JSON.stringify(change)).toEqual(T0);
    }
    const moved: [number, Record<string, unknown>][] = [
      [5, { searchWords: ["rennrad", "roadbike"] }],
      [6, { categoryId: "100002" }],
      [7, { conditionIds: ["3000", "2750"] }],
    ];
    for (const [at, change] of moved) {
      product = saved(await update(product, change, cli(minutes(at))));
      expect(product.watchFrom, JSON.stringify(change)).toEqual(minutes(at));
    }

    let draft = await create({ status: "draft" }, cli(T0));
    expect(draft.watchFrom).toBeNull();
    draft = saved(await update(draft, { searchWords: ["roadbike"] }, cli(minutes(1))));
    expect(draft.watchFrom).toBeNull();
    draft = saved(await update(draft, { status: "active" }, cli(minutes(2))));
    expect(draft.watchFrom).toEqual(minutes(2));
    draft = saved(await update(draft, { status: "paused" }, cli(minutes(3))));
    draft = saved(await update(draft, { status: "active" }, cli(minutes(4))));
    expect(draft.watchFrom).toEqual(minutes(2));
  });

  it("audits status and recipient changes on their own and refuses a new recipient who is not active", async () => {
    const active = await addPerson("buyer@example.com");
    const disabled = await addPerson("gone@example.com", "disabled");
    const product = await create();

    const recipients = saved(await update(product, { alertRecipientIds: [active] }, cli(minutes(1))));
    const refused = await update(recipients, { alertRecipientIds: [active, disabled] }, cli(minutes(2)));
    expect(refused).toEqual({
      ok: false,
      reason: "invalid",
      issues: [{ path: ["alertRecipientIds", 1], message: "Choose a person who is active." }],
    });

    const paused = saved(await update(recipients, { status: "paused", maxCents: 70_000 }, cli(minutes(3))));
    expect(paused.rules.alertRecipientIds).toEqual([active]);
    expect((await auditRows()).slice(1)).toEqual([
      {
        actor: "system:cli",
        action: "product.recipients_changed",
        detail: { key: product.key, version: 2, added: [active], removed: [] },
      },
      {
        actor: "system:cli",
        action: "product.status_changed",
        detail: { key: product.key, version: 3, before: "active", after: "paused" },
      },
      {
        actor: "system:cli",
        action: "product.updated",
        detail: { key: product.key, version: 3, changes: { maxCents: { before: 80_000, after: 70_000 } } },
      },
    ]);
  });

  it("writes nothing for a save without changes", async () => {
    const product = await create();

    expect(await update(product, {})).toMatchObject({ ok: true, product: { version: 1 }, plan: { total: 727 } });
    expect(await count("app.product_revision")).toBe(1);
    expect(await count("app.audit_event")).toBe(1);
  });

  it("retires a search left without members and never reuses its id", async () => {
    await create({ categoryId: "100001" });
    const other = await create({ categoryId: "100002" });
    const searchOf = async (productId: string): Promise<string | undefined> =>
      (await database.pool.query<{ search_id: string }>("SELECT search_id FROM app.search_product WHERE product_id = $1", [productId]))
        .rows[0]?.search_id;
    const left = await searchOf(other.id);

    // Both in one category share one search; the other search loses its members.
    const joined = saved(await update(other, { categoryId: "100001" }, cli(minutes(1))));
    saved(await update(joined, { categoryId: "100002" }, cli(minutes(2))));

    const retired = await database.pool.query<{ id: string; retired_at: Date | null }>(
      "SELECT id, retired_at FROM app.search WHERE retired_at IS NOT NULL",
    );
    expect(retired.rows).toEqual([{ id: left, retired_at: minutes(1) }]);
    const back = await searchOf(other.id);
    expect(back).toMatch(/^s[0-9]+$/);
    expect(back).not.toBe(left);
    expect(await count("app.search")).toBe(3);
    expect(await count("app.search_product")).toBe(2);
  });

  it("takes the buyer profile of a new product from the setting when the fields have none", async () => {
    await database.pool.query(`INSERT INTO app.setting (key, value) VALUES ('alerts.default_buyer_profile', '"company"')`);

    const product = await create({ buyerProfile: undefined });

    expect(product.rules.buyerProfile).toBe("company");
  });

  it("lets a save through that leaves a plan already over 2,500 no higher, and refuses one that raises it", async () => {
    const env = { ...ENV, claudeDailyCallLimit: 100 };
    for (const categoryId of ["100001", "100002", "100003", "100004"]) await create({ categoryId }, cli(T0, env));
    // Written past the store: 2,350 + 60 x 3 getItem calls.
    await database.pool.query("INSERT INTO app.setting (key, value) VALUES ('claude.daily_call_limit', '100')");
    const [product] = (await database.pool.query<{ key: string }>("SELECT key FROM app.product ORDER BY key")).rows;
    const stored = await loadProduct(database.pool, product?.key ?? "");
    if (stored === null) throw new Error("no product");

    const raise = await update(stored, { priceDropCheck: true }, cli(minutes(1), env));
    const price = await update(stored, { maxCents: 70_000 }, cli(minutes(1), env));

    expect(raise).toEqual({ ok: false, reason: "over_budget", plan: expect.objectContaining({ total: 2_554 }) });
    expect(price).toMatchObject({ ok: true, plan: { total: 2_530, ok: false } });
  });

  it("refuses invalid fields with every issue and gives a new product the sweep minute with the fewest sweeps", async () => {
    const invalid = await saveProductWithPlan(
      database.pool,
      { kind: "create", fields: fields({ name: "", conditionIds: ["7000"] }) },
      cli(),
    );
    const a = await create({ priceDropCheck: true, speed: "slow" });
    const b = await create({ priceDropCheck: true, speed: "slow" });
    const c = await create({ priceDropCheck: false, speed: "slow" });

    expect(invalid).toEqual({
      ok: false,
      reason: "invalid",
      issues: expect.arrayContaining([
        { path: ["name"], message: "Use 1 to 60 characters." },
        { path: ["conditionIds", 0], message: "For parts (7000) is never offered." },
      ]),
    });
    expect([a.sweepMinute, b.sweepMinute, c.sweepMinute]).toEqual([0, 1, 2]);
    expect(await count("app.product")).toBe(3);
  });
});

describe("saveSettings", () => {
  it("refuses a value above the .env ceiling and writes nothing", async () => {
    const result = await saveSettings(database.pool, [{ key: "claude.daily_call_limit", value: 50 }], cli(), EVALS);

    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      errors: [{ key: "claude.daily_call_limit", error: "The server ceiling is 40 calls a day (CLAUDE_DAILY_CALL_LIMIT)." }],
    });
    expect(await count("app.setting")).toBe(0);
    expect(await count("app.audit_event")).toBe(0);
  });

  it("stores the value in its stored form, bumps the version and audits before and after", async () => {
    const editor = await addPerson("editor@example.com");
    const asEditor: ConfigContext = { ...cli(minutes(1)), actor: `user:${editor}`, userId: editor };

    const first = await saveSettings(database.pool, [{ key: "claude.daily_spend_limit_usd", value: "1.5" }], cli(), EVALS);
    const second = await saveSettings(database.pool, [{ key: "claude.daily_spend_limit_usd", value: "1.75" }], asEditor, EVALS);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, settings: { settings: { claudeDailySpendLimitMicrousd: 1_750_000 } } });
    const rows = await database.pool.query("SELECT key, value, version, updated_by, updated_at FROM app.setting");
    expect(rows.rows).toEqual([
      { key: "claude.daily_spend_limit_usd", value: "1.75", version: 2, updated_by: editor, updated_at: minutes(1) },
    ]);
    expect(await auditRows()).toEqual([
      { actor: "system:cli", action: "setting.changed", detail: { key: "claude.daily_spend_limit_usd", before: null, after: "1.50" } },
      {
        actor: `user:${editor}`,
        action: "setting.changed",
        detail: { key: "claude.daily_spend_limit_usd", before: "1.50", after: "1.75" },
      },
    ]);
  });

  it("clamps a stored value above the ceiling on read and plans with the clamped value", async () => {
    await database.pool.query("INSERT INTO app.setting (key, value) VALUES ('claude.daily_call_limit', '100')");

    const resolved = await loadSettings(database.pool, ENV);
    const product = await saveProductWithPlan(database.pool, { kind: "create", fields: fields() }, cli());

    expect(resolved.settings.claudeDailyCallLimit).toBe(40);
    expect(resolved.warnings).toEqual(["Stored Claude call cap 100 is above the server ceiling 40; 40 applies."]);
    expect(product).toMatchObject({ ok: true, plan: { getItem: 126 } });
  });

  it("checks the call plan for the Claude call limit under the same lock", async () => {
    const env = { ...ENV, claudeDailyCallLimit: 100 };
    // 186 + 4 x 541 = 2,350 at 40 calls; each extra call adds 3 getItem calls.
    for (const categoryId of ["100001", "100002", "100003", "100004"]) await create({ categoryId }, cli(T0, env));

    const over = await saveSettings(database.pool, [{ key: "claude.daily_call_limit", value: 100 }], cli(T0, env), EVALS);
    const fits = await saveSettings(database.pool, [{ key: "claude.daily_call_limit", value: 80 }], cli(T0, env), EVALS);

    expect(over).toEqual({ ok: false, reason: "over_budget", plan: expect.objectContaining({ total: 2_530, ok: false }) });
    expect(fits).toMatchObject({ ok: true, plan: { total: 2_470 } });
    expect(await count("app.audit_event", "action = 'setting.changed'")).toBe(1);
  });

  it("accepts only a model and effort pair that passed the eval, saved together, and refuses unknown keys", async () => {
    const alone = await saveSettings(database.pool, [{ key: "claude.model", value: "claude-haiku-4-5" }], cli(), EVALS);
    const pair = await saveSettings(
      database.pool,
      [
        { key: "claude.model", value: "claude-haiku-4-5" },
        { key: "claude.effort", value: "low" },
      ],
      cli(),
      EVALS,
    );
    const unknown = await saveSettings(database.pool, [{ key: "claude.temperature", value: 1 }], cli(), EVALS);

    expect(alone).toEqual({
      ok: false,
      reason: "invalid",
      errors: [
        { key: "claude.model", error: "claude-haiku-4-5 at effort medium has not passed the screening eval for the current prompt." },
      ],
    });
    expect(pair).toMatchObject({ ok: true, settings: { settings: { claudeModel: "claude-haiku-4-5", claudeEffort: "low" } } });
    expect(unknown).toEqual({
      ok: false,
      reason: "invalid",
      errors: [{ key: "claude.temperature", error: "Unknown setting claude.temperature." }],
    });
    expect(await count("app.audit_event")).toBe(2);
  });
});

describe("as the web role", () => {
  it("saves products and settings with web's grants alone", async () => {
    const web = new pg.Pool({ connectionString: database.url, options: "-c role=web" });
    try {
      const created = saved(await saveProductWithPlan(web, { kind: "create", fields: fields() }, cli()));
      const moved = await saveProductWithPlan(
        web,
        { kind: "update", id: created.id, version: 1, fields: { ...created.rules, categoryId: "100002" } },
        cli(minutes(1)),
      );
      const settings = await saveSettings(web, [{ key: "alerts.per_hour", value: 5 }], cli(), EVALS);

      expect(moved).toMatchObject({ ok: true, product: { version: 2, matchVersion: 2 } });
      expect(settings).toMatchObject({ ok: true });
      expect(await loadProduct(web, created.key)).toMatchObject({ version: 2 });
      expect((await web.query<{ role: string }>("SELECT current_user AS role")).rows).toEqual([{ role: "web" }]);
    } finally {
      await web.end();
    }
  });
});

describe("previewPlan", () => {
  it("shows the cost of a product that joins a search and of one that opens a new search, and writes nothing", async () => {
    await create({ categoryId: "100001" });
    const search = (await database.pool.query<{ id: string }>("SELECT id FROM app.search")).rows[0]?.id;

    const joins = await previewPlan(database.pool, { fields: fields({ categoryId: "100001", speed: "normal" }) }, ENV);
    const opens = await previewPlan(database.pool, { fields: fields({ categoryId: "100002", speed: "normal" }) }, ENV);
    const invalid = await previewPlan(database.pool, { fields: fields({ maxCents: 0 }) }, ENV);

    expect(joins).toEqual({
      ok: true,
      before: expect.objectContaining({ total: 727 }),
      after: expect.objectContaining({ total: 730 }),
      searchId: search,
      fixes: [],
    });
    expect(opens).toMatchObject({ ok: true, after: { total: 980 }, searchId: null, fixes: [] });
    expect(invalid).toEqual({ ok: false, reason: "invalid", issues: [{ path: ["maxCents"], message: "Enter a price above 0." }] });
    expect(await count("app.product")).toBe(1);
    expect(await count("app.search")).toBe(1);
  });

  it("names the single changes that make a refused product fit, cheapest first, and previews an edit in place", async () => {
    const env = { ...ENV, claudeDailyCallLimit: 100 };
    for (const categoryId of ["100001", "100002", "100003"]) await create({ categoryId }, cli(T0, env));
    const normal = await create({ categoryId: "100004", speed: "normal" }, cli(T0, env));
    expect(await saveSettings(database.pool, [{ key: "claude.daily_call_limit", value: 100 }], cli(T0, env), EVALS)).toMatchObject({
      ok: true,
      plan: { total: 2_242 },
    });

    // A new category at normal speed with the price-drop check: 253 + 24.
    const preview = await previewPlan(
      database.pool,
      { fields: fields({ categoryId: "100005", speed: "normal", priceDropCheck: true }) },
      env,
    );
    const edit = await previewPlan(database.pool, { id: normal.id, fields: { ...normal.rules, speed: "slow" } }, env);

    expect(preview).toMatchObject({ ok: true, before: { total: 2_242 }, after: { total: 2_519, ok: false }, searchId: null });
    expect(preview.ok && preview.fixes).toEqual([
      { change: "speed_slow", total: 2_359, delta: 117 },
      { change: "no_price_drop_check", total: 2_495, delta: 253 },
    ]);
    expect(edit).toMatchObject({ ok: true, after: { total: 2_082 }, fixes: [] });
  });
});
