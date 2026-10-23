import { listProducts, loadProduct, saveProductWithPlan, type DbPool, type StoredProduct } from "@ebay-sniper/db";
import type { ProductStatus } from "@ebay-sniper/domain";
import { configContext, failed, refused, UsageError, withPool, type OpsDeps } from "./change.js";
import { importLegacyProducts } from "./legacy-import.js";

const USAGE =
  "usage: products list | show <key> | set <key> <field> <value> | pause <key> | resume <key> | archive <key> | pause-all | import-legacy";

// `products set` takes these values as typed and every other one as JSON (49000, true, null,
// ["a","b"]).
const TEXT_FIELDS: readonly string[] = ["name", "description", "status", "categoryId", "categoryName", "priceMode", "speed", "buyerProfile"];

// max_cents is the field maxCents of the product rules.
const camelCase = (field: string): string =>
  field
    .split("_")
    .map((part, at) => (at === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");

function fieldValue(field: string, value: string): unknown {
  if (TEXT_FIELDS.includes(field)) return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`the value of ${field} must be JSON, for example 49000, true or ["a","b"]`);
  }
}

// The legacy import writes as system:import (spec 2.7).
async function importLegacy(pool: DbPool, deps: OpsDeps): Promise<number> {
  const ctx = { at: deps.clock.now(), actor: "system:import", userId: null, env: deps.loadSettingsEnv() };
  const result = await importLegacyProducts(pool, ctx);
  if (!result.ok) return refused(deps, result);
  for (const { product, ruleVersion } of result.products) {
    deps.out(JSON.stringify({ key: product.key, ruleVersion, ...product.rules }));
  }
  deps.out(JSON.stringify({ imported: result.products.length, plan: result.plan }));
  return 0;
}

async function list(pool: DbPool, deps: OpsDeps): Promise<number> {
  for (const { key, version, rules } of await listProducts(pool)) {
    const { name, status, categoryId, priceMode, maxCents, perGb, speed } = rules;
    deps.out(JSON.stringify({ key, name, status, version, categoryId, priceMode, maxCents, perGb, speed }));
  }
  return 0;
}

async function show(pool: DbPool, deps: OpsDeps, key: string): Promise<number> {
  const product = await loadProduct(pool, key);
  if (product === null) return refused(deps, { ok: false, reason: "not_found", key });
  deps.out(JSON.stringify(product));
  return 0;
}

// Through the same product rules, plan check and audit as the form.
async function save(pool: DbPool, deps: OpsDeps, product: StoredProduct, fields: Record<string, unknown>): Promise<number> {
  const update = { kind: "update" as const, id: product.id, version: product.version, fields };
  const result = await saveProductWithPlan(pool, update, configContext(deps));
  if (!result.ok) return refused(deps, result);
  deps.out(JSON.stringify({ ...result.product, plan: result.plan }));
  return 0;
}

async function set(pool: DbPool, deps: OpsDeps, key: string, field: string, value: string): Promise<number> {
  const product = await loadProduct(pool, key);
  if (product === null) return refused(deps, { ok: false, reason: "not_found", key });
  const name = camelCase(field);
  if (!Object.hasOwn(product.rules, name)) throw new UsageError(`unknown field ${field}`);
  return save(pool, deps, product, { ...product.rules, [name]: fieldValue(name, value) });
}

// The status each action sets and the ones it starts from. A draft is activated in the form, or
// with `set <key> status active`.
const STATUS_CHANGES: Record<"pause" | "resume" | "archive", { from: readonly ProductStatus[]; to: ProductStatus }> = {
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  archive: { from: ["draft", "active", "paused"], to: "archived" },
};

async function changeStatus(pool: DbPool, deps: OpsDeps, key: string, action: keyof typeof STATUS_CHANGES): Promise<number> {
  const product = await loadProduct(pool, key);
  if (product === null) return refused(deps, { ok: false, reason: "not_found", key });
  const { from, to } = STATUS_CHANGES[action];
  if (!from.includes(product.rules.status)) return refused(deps, { ok: false, reason: "status", key, status: product.rules.status });
  return save(pool, deps, product, { ...product.rules, status: to });
}

// Stops every poll and sweep at once. Each product is its own save; one refused (an edit at the
// same time) does not stop the others, and the exit code is 1.
async function pauseAll(pool: DbPool, deps: OpsDeps): Promise<number> {
  let code = 0;
  for (const product of await listProducts(pool)) {
    if (product.rules.status !== "active") continue;
    code = Math.max(code, await save(pool, deps, product, { ...product.rules, status: "paused" }));
  }
  return code;
}

export async function runProductsCommand(args: readonly string[], deps: OpsDeps): Promise<number> {
  try {
    const [action, key, field, value] = args;
    if (action === "import-legacy" && args.length === 1) return await withPool(deps, (pool) => importLegacy(pool, deps));
    if (action === "list" && args.length === 1) return await withPool(deps, (pool) => list(pool, deps));
    if (action === "pause-all" && args.length === 1) return await withPool(deps, (pool) => pauseAll(pool, deps));
    if (action === "show" && key !== undefined && args.length === 2) return await withPool(deps, (pool) => show(pool, deps, key));
    if ((action === "pause" || action === "resume" || action === "archive") && key !== undefined && args.length === 2) {
      return await withPool(deps, (pool) => changeStatus(pool, deps, key, action));
    }
    if (action === "set" && key !== undefined && field !== undefined && value !== undefined && args.length === 4) {
      return await withPool(deps, (pool) => set(pool, deps, key, field, value));
    }
    throw new UsageError(USAGE);
  } catch (error) {
    return failed(deps, error);
  }
}
