import { randomBytes } from "node:crypto";
import {
  checkModelChoice,
  checkSetting,
  parseProductRules,
  pickSweepMinute,
  planProductCalls,
  planSearches,
  productKeyFromBytes,
  resolveSettings,
  type DailyCallPlan,
  type ExistingSearch,
  type ModelChoice,
  type PlanProduct,
  type PlannedSearch,
  type ProductIssue,
  type ProductRules,
  type ProductStatus,
  type ResolvedSettings,
  type SettingsEnv,
} from "@ebay-sniper/domain";
import type pg from "pg";
import { recordAuditEvent } from "./audit.js";
import type { DbPool, Queryable } from "./pool.js";

// Spec 5.3. Products and settings are saved here, by web, the ops CLI and the legacy import. Every
// save takes the config lock, writes its revision and audit rows, rebuilds the searches and checks
// the daily call plan from the written rows, all in one transaction.

export const CONFIG_LOCK_KEY = 7305508719535482471n; // 0x65626179636e6667, ASCII "ebaycnfg"

// actor is "user:<uuid>", "system:cli" or "system:import"; userId is the person behind a user actor.
export type ConfigContext = { at: Date; actor: string; userId: string | null; env: SettingsEnv };

export type StoredProduct = {
  id: string;
  key: string;
  version: number;
  matchVersion: number;
  sweepMinute: number;
  watchFrom: Date | null;
  ebayEnabled: boolean;
  updatedBy: string | null;
  updatedAt: Date;
  rules: ProductRules;
};

// An update names the version the form loaded; `fields` are all editable fields, as for a create.
// A create gets a new random key; the legacy import passes the segment key it keeps.
export type ProductSave =
  | { kind: "create"; key?: string; fields: unknown }
  | { kind: "update"; id: string; version: number; fields: unknown };

export type ProductSaveResult =
  | { ok: true; product: StoredProduct; plan: DailyCallPlan }
  | { ok: false; reason: "invalid"; issues: ProductIssue[] }
  | { ok: false; reason: "not_found" }
  // changedBy is the person's email address, or the actor ("system:cli") of a change without one.
  | { ok: false; reason: "conflict"; changedBy: string; changedAt: Date }
  | { ok: false; reason: "over_budget"; plan: DailyCallPlan };

export type SaveOptions = { keyBytes?: (size: number) => Uint8Array };

const KEY_BYTES = 7;
const KEY_RETRIES = 3;

// Spec 2.1: a change to one of these bumps match_version, which ties market rows to the rules.
const MATCHING_FIELDS: readonly (keyof ProductRules)[] = [
  "searchWords",
  "mustWords",
  "excludeWords",
  "useDefaultJunk",
  "junkExceptions",
  "accessoryCheck",
  "categoryId",
  "conditionIds",
  "perGb",
  "unitMinTotal",
];

// Spec 5.5: these change the derived search, so listings created before the edit are a baseline.
const SEARCH_FIELDS: readonly (keyof ProductRules)[] = ["searchWords", "categoryId", "conditionIds"];

// The product columns the form edits, in the order of ruleValues.
const RULE_COLUMNS = [
  "name",
  "description",
  "status",
  "category_id",
  "category_name",
  "condition_ids",
  "search_words",
  "must_words",
  "exclude_words",
  "warn_words",
  "use_default_junk",
  "junk_exceptions",
  "accessory_check",
  "per_gb",
  "unit_min_total",
  "unit_max_total",
  "price_mode",
  "max_cents",
  "below_market_pct",
  "floor_cents",
  "read_ceiling_cents",
  "speed",
  "price_drop_check",
  "candidate_cap_per_day",
  "buyer_profile",
  "claude_required",
  "alert_recipient_ids",
] as const;

const ruleValues = (rules: ProductRules): unknown[] => [
  rules.name,
  rules.description,
  rules.status,
  rules.categoryId,
  rules.categoryName,
  rules.conditionIds,
  rules.searchWords,
  JSON.stringify(rules.mustWords),
  rules.excludeWords,
  rules.warnWords,
  rules.useDefaultJunk,
  rules.junkExceptions,
  rules.accessoryCheck,
  rules.perGb,
  rules.unitMinTotal,
  rules.unitMaxTotal,
  rules.priceMode,
  rules.maxCents,
  rules.belowMarketPct,
  rules.floorCents,
  rules.readCeilingCents,
  rules.speed,
  rules.priceDropCheck,
  rules.candidateCapPerDay,
  rules.buyerProfile,
  rules.claudeRequired,
  rules.alertRecipientIds,
];

type ProductRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  status: ProductStatus;
  category_id: string;
  category_name: string | null;
  condition_ids: string[];
  search_words: string[];
  must_words: string[][];
  exclude_words: string[];
  warn_words: string[];
  use_default_junk: boolean;
  junk_exceptions: string[];
  accessory_check: boolean;
  per_gb: boolean;
  unit_min_total: number | null;
  unit_max_total: number | null;
  price_mode: ProductRules["priceMode"];
  max_cents: number;
  below_market_pct: number | null;
  floor_cents: number | null;
  read_ceiling_cents: number | null;
  speed: ProductRules["speed"];
  price_drop_check: boolean;
  sweep_minute: number;
  candidate_cap_per_day: number;
  buyer_profile: ProductRules["buyerProfile"];
  claude_required: boolean;
  alert_recipient_ids: string[];
  version: number;
  match_version: number;
  watch_from: Date | null;
  updated_by: string | null;
  updated_at: Date;
  ebay_enabled: boolean;
};

const PRODUCT_SELECT = `SELECT p.*, coalesce(s.enabled, false) AS ebay_enabled
  FROM app.product p LEFT JOIN app.product_source s ON s.product_id = p.id AND s.source = 'ebay'`;

function toStored(row: ProductRow): StoredProduct {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    matchVersion: row.match_version,
    sweepMinute: row.sweep_minute,
    watchFrom: row.watch_from,
    ebayEnabled: row.ebay_enabled,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    rules: {
      name: row.name,
      description: row.description,
      status: row.status,
      categoryId: row.category_id,
      categoryName: row.category_name,
      conditionIds: row.condition_ids,
      searchWords: row.search_words,
      mustWords: row.must_words,
      excludeWords: row.exclude_words,
      warnWords: row.warn_words,
      useDefaultJunk: row.use_default_junk,
      junkExceptions: row.junk_exceptions,
      accessoryCheck: row.accessory_check,
      perGb: row.per_gb,
      unitMinTotal: row.unit_min_total,
      unitMaxTotal: row.unit_max_total,
      priceMode: row.price_mode,
      maxCents: row.max_cents,
      belowMarketPct: row.below_market_pct,
      floorCents: row.floor_cents,
      readCeilingCents: row.read_ceiling_cents,
      speed: row.speed,
      priceDropCheck: row.price_drop_check,
      candidateCapPerDay: row.candidate_cap_per_day,
      buyerProfile: row.buyer_profile,
      claudeRequired: row.claude_required,
      alertRecipientIds: row.alert_recipient_ids,
    },
  };
}

export async function loadProduct(db: Queryable, key: string): Promise<StoredProduct | null> {
  const result = await db.query<ProductRow>(`${PRODUCT_SELECT} WHERE p.key = $1`, [key]);
  const row = result.rows[0];
  return row === undefined ? null : toStored(row);
}

async function loadProductById(db: Queryable, id: string, lock = false): Promise<StoredProduct | null> {
  const result = await db.query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1${lock ? " FOR UPDATE OF p" : ""}`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toStored(row);
}

async function reload(db: Queryable, id: string): Promise<StoredProduct> {
  const product = await loadProductById(db, id);
  if (product === null) throw new Error(`product ${id} is gone`);
  return product;
}

// Every product, archived ones included, by key.
export async function listProducts(db: Queryable): Promise<StoredProduct[]> {
  const result = await db.query<ProductRow>(`${PRODUCT_SELECT} ORDER BY p.key`);
  return result.rows.map(toStored);
}

export async function loadSettings(db: Queryable, env: SettingsEnv): Promise<ResolvedSettings> {
  const result = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM app.setting");
  return resolveSettings(result.rows, env);
}

const toPlanProduct = (product: StoredProduct): PlanProduct => ({
  ...product.rules,
  id: product.id,
  key: product.key,
  ebayEnabled: product.ebayEnabled,
});

// The next number app.search_id_seq hands out, without taking it.
async function nextSearchNumber(db: Queryable): Promise<number> {
  const result = await db.query<{ last: string | null }>(
    "SELECT pg_sequence_last_value('app.search_id_seq'::regclass) AS last",
  );
  const last = result.rows[0]?.last ?? null;
  return last === null ? 1 : Number(last) + 1;
}

async function existingSearches(db: Queryable): Promise<ExistingSearch[]> {
  const result = await db.query<{ id: string; retired: boolean; product_ids: string[] }>(
    `SELECT s.id, s.retired_at IS NOT NULL AS retired,
       coalesce(array_agg(sp.product_id::text) FILTER (WHERE sp.product_id IS NOT NULL), '{}') AS product_ids
     FROM app.search s LEFT JOIN app.search_product sp ON sp.search_id = s.id GROUP BY s.id`,
  );
  return result.rows.map((row) => ({ id: row.id, retired: row.retired, productIds: row.product_ids }));
}

async function writeSearch(db: Queryable, search: PlannedSearch, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO app.search
       (id, category_id, condition_ids, q, floor_eur, ceiling_eur, day_interval_s, night_interval_s, enabled, members_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       category_id = EXCLUDED.category_id, condition_ids = EXCLUDED.condition_ids, q = EXCLUDED.q,
       floor_eur = EXCLUDED.floor_eur, ceiling_eur = EXCLUDED.ceiling_eur, day_interval_s = EXCLUDED.day_interval_s,
       night_interval_s = EXCLUDED.night_interval_s, enabled = EXCLUDED.enabled, members_hash = EXCLUDED.members_hash,
       updated_at = EXCLUDED.updated_at
     WHERE (search.category_id, search.condition_ids, search.q, search.floor_eur, search.ceiling_eur, search.day_interval_s,
            search.night_interval_s, search.enabled, search.members_hash)
       IS DISTINCT FROM (EXCLUDED.category_id, EXCLUDED.condition_ids, EXCLUDED.q, EXCLUDED.floor_eur, EXCLUDED.ceiling_eur,
            EXCLUDED.day_interval_s, EXCLUDED.night_interval_s, EXCLUDED.enabled, EXCLUDED.members_hash)`,
    [
      search.id,
      search.categoryId,
      search.conditionIds,
      search.q,
      search.floorEur,
      search.ceilingEur,
      search.dayIntervalS,
      search.nightIntervalS,
      search.enabled,
      search.membersHash,
      at,
    ],
  );
}

// Spec 5.1: app.search and app.search_product follow the stored products. Searches are retired,
// never deleted, and app.search_id_seq moves past every id the planner took.
async function rebuildSearches(db: Queryable, products: readonly PlanProduct[], at: Date): Promise<PlannedSearch[]> {
  const next = await nextSearchNumber(db);
  const plan = planSearches(products, await existingSearches(db), next);
  for (const search of plan.searches) await writeSearch(db, search, at);
  if (plan.retire.length > 0) {
    await db.query("UPDATE app.search SET retired_at = $2, enabled = false, updated_at = $2 WHERE id = ANY($1)", [
      plan.retire,
      at,
    ]);
  }
  await db.query("DELETE FROM app.search_product");
  const members = plan.searches.flatMap((search) => search.productIds.map((productId) => [search.id, productId] as const));
  await db.query("INSERT INTO app.search_product (search_id, product_id) SELECT * FROM unnest($1::text[], $2::uuid[])", [
    members.map(([searchId]) => searchId),
    members.map(([, productId]) => productId),
  ]);
  if (plan.nextSearchNumber > next) {
    await db.query("SELECT nextval('app.search_id_seq') FROM generate_series(1, $1)", [plan.nextSearchNumber - next]);
  }
  return plan.searches;
}

// Rebuilds the searches from the stored rows and returns the daily call plan they give.
async function replan(db: Queryable, env: SettingsEnv, at: Date): Promise<DailyCallPlan> {
  const products = (await listProducts(db)).map(toPlanProduct);
  const searches = await rebuildSearches(db, products, at);
  return planProductCalls(searches, products, (await loadSettings(db, env)).settings);
}

// The plan of the stored rows, written nowhere.
async function storedPlan(db: Queryable, env: SettingsEnv): Promise<DailyCallPlan> {
  const products = (await listProducts(db)).map(toPlanProduct);
  const plan = planSearches(products, await existingSearches(db), await nextSearchNumber(db));
  return planProductCalls(plan.searches, products, (await loadSettings(db, env)).settings);
}

// A save over the ceiling is refused, unless the plan was over before (a lowered .env, hand-written
// SQL) and the save does not raise it: otherwise no edit could be saved until someone fixed that.
const raisesPastCeiling = (previous: DailyCallPlan, plan: DailyCallPlan): boolean =>
  !plan.ok && plan.total > previous.total;

const placeholders = (from: number, count: number): string =>
  Array.from({ length: count }, (_, at) => `$${from + at}`).join(", ");

async function insertProduct(
  db: Queryable,
  rules: ProductRules,
  key: string,
  sweepMinute: number,
  ctx: ConfigContext,
): Promise<string> {
  const watched = rules.status === "active" || rules.status === "paused";
  const columns = [...RULE_COLUMNS, "key", "sweep_minute", "watch_from", "created_by", "updated_by", "created_at", "updated_at"];
  const values = [...ruleValues(rules), key, sweepMinute, watched ? ctx.at : null, ctx.userId, ctx.userId, ctx.at, ctx.at];
  const result = await db.query<{ id: string }>(
    `INSERT INTO app.product (${columns.join(", ")}) VALUES (${placeholders(1, values.length)}) RETURNING id`,
    values,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("product insert returned no id");
  return id;
}

// Spec 2.1: a new product's buyer profile defaults to the setting alerts.default_buyer_profile.
async function withBuyerProfile(db: Queryable, fields: unknown, env: SettingsEnv): Promise<unknown> {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return fields;
  if ("buyerProfile" in fields && fields.buyerProfile !== undefined && fields.buyerProfile !== null) return fields;
  return { ...fields, buyerProfile: (await loadSettings(db, env)).settings.defaultBuyerProfile };
}

const PRODUCT_KEY = /^[a-z][a-z0-9_]{1,39}$/;

async function givenKeyIssue(db: Queryable, key: string): Promise<string | null> {
  if (!PRODUCT_KEY.test(key)) return "Use 2 to 40 lowercase letters, digits or _, starting with a letter.";
  const taken = await db.query("SELECT 1 FROM app.product WHERE key = $1", [key]);
  return taken.rows.length > 0 ? "A product with this key exists." : null;
}

// A person added to the recipients must be active. One who was disabled later stays in the list
// until someone removes them; send skips them (spec 9).
async function newRecipientIssues(
  db: Queryable,
  ids: readonly string[],
  stored: readonly string[],
): Promise<ProductIssue[]> {
  const added = ids.filter((id) => !stored.includes(id));
  if (added.length === 0) return [];
  const result = await db.query<{ id: string }>(
    "SELECT id::text AS id FROM auth.app_user WHERE id = ANY($1::uuid[]) AND status = 'active'",
    [added],
  );
  const active = new Set(result.rows.map((row) => row.id));
  return ids.flatMap((id, at) =>
    added.includes(id) && !active.has(id) ? [{ path: ["alertRecipientIds", at], message: "Choose a person who is active." }] : [],
  );
}

const isKeyTaken = (error: unknown): boolean =>
  error instanceof Error && "constraint" in error && error.constraint === "product_key_unique";

// Spec 2.1: on a taken key the save retries up to 3 times with a new one. The savepoint keeps
// the transaction usable after the unique violation.
async function insertWithNewKey(
  db: Queryable,
  rules: ProductRules,
  sweepMinute: number,
  ctx: ConfigContext,
  keyBytes: (size: number) => Uint8Array,
): Promise<string> {
  for (let retry = 0; ; retry++) {
    await db.query("SAVEPOINT product_key");
    try {
      const id = await insertProduct(db, rules, productKeyFromBytes(keyBytes(KEY_BYTES)), sweepMinute, ctx);
      await db.query("RELEASE SAVEPOINT product_key");
      return id;
    } catch (error) {
      if (!isKeyTaken(error) || retry === KEY_RETRIES) throw error;
      await db.query("ROLLBACK TO SAVEPOINT product_key");
    }
  }
}

async function updateProduct(
  db: Queryable,
  id: string,
  rules: ProductRules,
  versions: { matchVersion: number; watchFrom: Date | null },
  ctx: ConfigContext,
): Promise<void> {
  const values = ruleValues(rules);
  const set = RULE_COLUMNS.map((column, at) => `${column} = $${at + 2}`).join(", ");
  const n = values.length + 2;
  await db.query(
    `UPDATE app.product SET ${set}, version = version + 1, match_version = $${n}, watch_from = $${n + 1},
       updated_by = $${n + 2}, updated_at = $${n + 3} WHERE id = $1`,
    [id, ...values, versions.matchVersion, versions.watchFrom, ctx.userId, ctx.at],
  );
}

// The minute with the fewest hourly sweeps of the other products.
async function freeSweepMinute(db: Queryable): Promise<number> {
  const result = await db.query<{ sweep_minute: number }>(
    "SELECT sweep_minute FROM app.product WHERE status <> 'archived' AND price_drop_check",
  );
  return pickSweepMinute(result.rows.map((row) => row.sweep_minute));
}

// The revision holds the whole row as it was written.
const revisionRules = (product: StoredProduct): Record<string, unknown> => ({
  key: product.key,
  ...product.rules,
  matchVersion: product.matchVersion,
  sweepMinute: product.sweepMinute,
  watchFrom: product.watchFrom,
  ebayEnabled: product.ebayEnabled,
});

async function writeRevision(db: Queryable, product: StoredProduct, ctx: ConfigContext): Promise<void> {
  await db.query("INSERT INTO app.product_revision (product_id, version, rules, actor, created_at) VALUES ($1, $2, $3, $4, $5)", [
    product.id,
    product.version,
    revisionRules(product),
    ctx.actor,
    ctx.at,
  ]);
}

// One open request per product (the partial unique index); a second one is not needed.
async function requestMarketValue(
  db: Queryable,
  productId: string,
  reason: "created" | "rules_changed",
  ctx: ConfigContext,
): Promise<void> {
  await db.query(
    `INSERT INTO app.market_request (product_id, requested_by, reason, requested_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id) WHERE status IN ('open', 'queued', 'running') DO NOTHING`,
    [productId, ctx.userId, reason, ctx.at],
  );
}

// Lists compare as sets, so the same words in another order are no change.
function canonical(value: unknown): string {
  return Array.isArray(value) ? `[${value.map(canonical).sort().join(",")}]` : JSON.stringify(value);
}

const changedFields = (before: ProductRules, after: ProductRules): (keyof ProductRules)[] =>
  (Object.keys(after) as (keyof ProductRules)[]).filter((field) => canonical(before[field]) !== canonical(after[field]));

// Who made the stored version: the person's address, else the actor of its revision.
async function changedBy(db: Queryable, product: StoredProduct): Promise<string> {
  if (product.updatedBy !== null) {
    const person = await db.query<{ email: string }>("SELECT email FROM auth.app_user WHERE id = $1", [product.updatedBy]);
    const email = person.rows[0]?.email;
    if (email !== undefined) return email;
  }
  const revision = await db.query<{ actor: string }>(
    "SELECT actor FROM app.product_revision WHERE product_id = $1 ORDER BY version DESC LIMIT 1",
    [product.id],
  );
  return revision.rows[0]?.actor ?? "unknown";
}

async function createProduct(
  db: Queryable,
  rules: ProductRules,
  key: string | null,
  ctx: ConfigContext,
  options: SaveOptions,
): Promise<StoredProduct> {
  const sweepMinute = await freeSweepMinute(db);
  const id =
    key === null
      ? await insertWithNewKey(db, rules, sweepMinute, ctx, options.keyBytes ?? randomBytes)
      : await insertProduct(db, rules, key, sweepMinute, ctx);
  await db.query("INSERT INTO app.product_source (product_id, source, enabled) VALUES ($1, 'ebay', true)", [id]);
  const product = await reload(db, id);
  await writeRevision(db, product, ctx);
  await recordAuditEvent(db, {
    at: ctx.at,
    actor: ctx.actor,
    action: "product.created",
    detail: { key: product.key, version: product.version, after: product.rules },
  });
  await requestMarketValue(db, id, "created", ctx);
  return product;
}

async function changeProduct(
  db: Queryable,
  before: StoredProduct,
  rules: ProductRules,
  ctx: ConfigContext,
): Promise<StoredProduct> {
  const changed = changedFields(before.rules, rules);
  const matching = changed.some((field) => MATCHING_FIELDS.includes(field));
  const watched = rules.status === "active" || rules.status === "paused";
  const searchChanged = changed.some((field) => SEARCH_FIELDS.includes(field));
  await updateProduct(
    db,
    before.id,
    rules,
    {
      matchVersion: before.matchVersion + (matching ? 1 : 0),
      watchFrom: watched && (before.watchFrom === null || searchChanged) ? ctx.at : before.watchFrom,
    },
    ctx,
  );
  const after = await reload(db, before.id);
  await writeRevision(db, after, ctx);
  await auditChanges(db, before, after, changed, ctx);
  if (matching && rules.status !== "archived") await requestMarketValue(db, before.id, "rules_changed", ctx);
  return after;
}

// Status and recipient changes get their own actions (spec 2.7), so the security mail and the
// activity page can find them; every other field goes into product.updated.
async function auditChanges(
  db: Queryable,
  before: StoredProduct,
  after: StoredProduct,
  changed: readonly (keyof ProductRules)[],
  ctx: ConfigContext,
): Promise<void> {
  const event = { at: ctx.at, actor: ctx.actor };
  const head = { key: after.key, version: after.version };
  if (changed.includes("alertRecipientIds")) {
    const old = before.rules.alertRecipientIds;
    const now = after.rules.alertRecipientIds;
    await recordAuditEvent(db, {
      ...event,
      action: "product.recipients_changed",
      detail: { ...head, added: now.filter((id) => !old.includes(id)), removed: old.filter((id) => !now.includes(id)) },
    });
  }
  if (changed.includes("status")) {
    await recordAuditEvent(db, {
      ...event,
      action: "product.status_changed",
      detail: { ...head, before: before.rules.status, after: after.rules.status },
    });
  }
  const other = changed.filter((field) => field !== "status" && field !== "alertRecipientIds");
  if (other.length === 0) return;
  const changes = Object.fromEntries(
    other.map((field) => [field, { before: before.rules[field], after: after.rules[field] }]),
  );
  await recordAuditEvent(db, { ...event, action: "product.updated", detail: { ...head, changes } });
}

async function saveInTransaction(
  db: Queryable,
  save: ProductSave,
  ctx: ConfigContext,
  options: SaveOptions,
): Promise<ProductSaveResult> {
  await db.query("SELECT pg_advisory_xact_lock($1)", [CONFIG_LOCK_KEY.toString()]);
  const before = save.kind === "update" ? await loadProductById(db, save.id, true) : null;
  if (save.kind === "update") {
    if (before === null) return { ok: false, reason: "not_found" };
    if (before.version !== save.version) {
      return { ok: false, reason: "conflict", changedBy: await changedBy(db, before), changedAt: before.updatedAt };
    }
  }
  const parsed = parseProductRules(save.kind === "create" ? await withBuyerProfile(db, save.fields, ctx.env) : save.fields);
  if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues };
  const key = save.kind === "create" ? (save.key ?? null) : null;
  const keyIssue = key === null ? null : await givenKeyIssue(db, key);
  if (keyIssue !== null) return { ok: false, reason: "invalid", issues: [{ path: ["key"], message: keyIssue }] };
  const recipients = await newRecipientIssues(db, parsed.value.alertRecipientIds, before?.rules.alertRecipientIds ?? []);
  if (recipients.length > 0) return { ok: false, reason: "invalid", issues: recipients };
  const previous = await storedPlan(db, ctx.env);
  if (before !== null && changedFields(before.rules, parsed.value).length === 0) {
    return { ok: true, product: before, plan: previous };
  }
  const product =
    before === null
      ? await createProduct(db, parsed.value, key, ctx, options)
      : await changeProduct(db, before, parsed.value, ctx);
  const plan = await replan(db, ctx.env, ctx.at);
  if (raisesPastCeiling(previous, plan)) return { ok: false, reason: "over_budget", plan };
  return { ok: true, product, plan };
}

// Rolled back unless the result is ok.
export async function saveProductWithPlan(
  pool: DbPool,
  save: ProductSave,
  ctx: ConfigContext,
  options: SaveOptions = {},
): Promise<ProductSaveResult> {
  return inTransaction(pool, (client) => saveInTransaction(client, save, ctx, options));
}

// A change to the draft that brings a refused plan under the ceiling (spec 5.3: "Fits at slow
// speed (+93) or without the price-drop check"). delta is the draft's cost with that change.
export type PlanFix = { change: "speed_normal" | "speed_slow" | "no_price_drop_check"; total: number; delta: number };

// searchId: the live search the draft joins, null when it gets a new one or none (a draft).
export type PlanPreview =
  | { ok: true; before: DailyCallPlan; after: DailyCallPlan; searchId: string | null; fixes: PlanFix[] }
  | { ok: false; reason: "invalid"; issues: ProductIssue[] };

// Stands in for the id of a product that is not saved yet.
const DRAFT_ID = "00000000-0000-0000-0000-000000000000";

// The cost box of the form (spec 5.3): the plan with the draft in place of its stored row (or
// added), next to the plan of the stored rows. Writes nothing and takes no lock.
export async function previewPlan(
  db: Queryable,
  draft: { id?: string; fields: unknown },
  env: SettingsEnv,
): Promise<PlanPreview> {
  const parsed = parseProductRules(draft.id === undefined ? await withBuyerProfile(db, draft.fields, env) : draft.fields);
  if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues };
  const stored = await listProducts(db);
  const existing = await existingSearches(db);
  const next = await nextSearchNumber(db);
  const { settings } = await loadSettings(db, env);
  const plan = (products: readonly PlanProduct[]) => {
    const { searches } = planSearches(products, existing, next);
    return { searches, calls: planProductCalls(searches, products, settings) };
  };
  const own = stored.find((product) => product.id === draft.id);
  const others = stored.filter((product) => product !== own).map(toPlanProduct);
  const id = own?.id ?? DRAFT_ID;
  const withDraft = (rules: ProductRules) =>
    plan([...others, { ...rules, id, key: own?.key ?? "draft", ebayEnabled: own?.ebayEnabled ?? true }]);
  const before = plan(stored.map(toPlanProduct)).calls;
  const after = withDraft(parsed.value);
  const joined = after.searches.find((search) => search.productIds.includes(id))?.id;
  const live = existing.some((search) => search.id === joined && !search.retired);
  const fixes = after.calls.ok
    ? []
    : fixCandidates(parsed.value)
        .map(([change, patch]) => ({ change, calls: withDraft({ ...parsed.value, ...patch }).calls }))
        .filter(({ calls }) => calls.ok)
        .map(({ change, calls }) => ({ change, total: calls.total, delta: calls.total - before.total }))
        .sort((a, b) => a.total - b.total);
  return { ok: true, before, after: after.calls, searchId: live && joined !== undefined ? joined : null, fixes };
}

function fixCandidates(rules: ProductRules): [PlanFix["change"], Partial<ProductRules>][] {
  const fixes: [PlanFix["change"], Partial<ProductRules>][] = [];
  if (rules.speed === "fast") fixes.push(["speed_normal", { speed: "normal" }]);
  if (rules.speed !== "slow") fixes.push(["speed_slow", { speed: "slow" }]);
  if (rules.priceDropCheck) fixes.push(["no_price_drop_check", { priceDropCheck: false }]);
  return fixes;
}

export type SettingChange = { key: string; value: unknown };

export type SettingsSaveResult =
  | { ok: true; settings: ResolvedSettings; plan: DailyCallPlan }
  | { ok: false; reason: "invalid"; errors: { key: string; error: string }[] }
  | { ok: false; reason: "over_budget"; plan: DailyCallPlan };

// Spec 2.5: refused above the .env ceiling on save; loadSettings applies the ceiling again on read.
async function saveSettingsInTransaction(
  db: Queryable,
  changes: readonly SettingChange[],
  ctx: ConfigContext,
  screeningEvals: readonly ModelChoice[],
): Promise<SettingsSaveResult> {
  await db.query("SELECT pg_advisory_xact_lock($1)", [CONFIG_LOCK_KEY.toString()]);
  const checked = changes.map((change) => ({ key: change.key, check: checkSetting(change.key, change.value, ctx.env) }));
  const errors = checked.flatMap(({ key, check }) => (check.ok ? [] : [{ key, error: check.error }]));
  if (errors.length > 0) return { ok: false, reason: "invalid", errors };
  // The Claude call limit sets the getItem line of the plan (spec 5.3).
  const previous = await storedPlan(db, ctx.env);
  for (const { key, check } of checked) {
    if (check.ok) await writeSetting(db, key, check.value, ctx);
  }
  const settings = await loadSettings(db, ctx.env);
  // Spec 4.6: model and effort together must be a pair that passed the screening eval.
  const modelKey = changes.find((change) => change.key === "claude.model" || change.key === "claude.effort")?.key;
  if (modelKey !== undefined) {
    const choice = checkModelChoice({ model: settings.settings.claudeModel, effort: settings.settings.claudeEffort }, screeningEvals);
    if (!choice.ok) return { ok: false, reason: "invalid", errors: [{ key: modelKey, error: choice.error }] };
  }
  const plan = await storedPlan(db, ctx.env);
  if (raisesPastCeiling(previous, plan)) return { ok: false, reason: "over_budget", plan };
  return { ok: true, settings, plan };
}

async function writeSetting(db: Queryable, key: string, value: unknown, ctx: ConfigContext): Promise<void> {
  const stored = await db.query<{ value: unknown }>("SELECT value FROM app.setting WHERE key = $1 FOR UPDATE", [key]);
  await db.query(
    `INSERT INTO app.setting (key, value, updated_by, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = setting.version + 1,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), ctx.userId, ctx.at],
  );
  await recordAuditEvent(db, {
    at: ctx.at,
    actor: ctx.actor,
    action: "setting.changed",
    detail: { key, before: stored.rows[0]?.value ?? null, after: value },
  });
}

// Rolled back unless the result is ok. screeningEvals: the (model, effort) pairs packages/llm lists
// as passed for the current prompt version.
export async function saveSettings(
  pool: DbPool,
  changes: readonly SettingChange[],
  ctx: ConfigContext,
  screeningEvals: readonly ModelChoice[],
): Promise<SettingsSaveResult> {
  return inTransaction(pool, (client) => saveSettingsInTransaction(client, changes, ctx, screeningEvals));
}

async function inTransaction<T extends { ok: boolean }>(pool: DbPool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
