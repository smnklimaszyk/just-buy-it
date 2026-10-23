import {
  listProducts,
  loadSettings,
  recordAuditEvent,
  saveProductWithPlan,
  type ConfigContext,
  type DbPool,
  type ProductSaveResult,
  type StoredProduct,
} from "@ebay-sniper/db";
import { parseProductRules, type BuyerProfile, type DailyCallPlan, type ProductIssue } from "@ebay-sniper/domain";

// Spec 2.13: `ops products import-legacy` turns the MVP's segment rules into product drafts, once,
// in the deploy. It reads only database rows, so the values Release 0 edited with `ops rules set`
// and `ops feeds set` come along, and no product word or price is in this file. Each draft is
// saved through saveProductWithPlan, so the planner, the config lock and the audit apply.
// Removed in the cleanup step V9.

type LegacyRow = {
  segment: string;
  rule_kind: "per_item" | "per_gb";
  max_landed_cents: number | null;
  floor_cents: number | null;
  max_cents_per_gb: number | null;
  min_cents_per_gb: number | null;
  min_total_gb: number | null;
  sweep_q: string;
  candidate_cap_per_day: number;
  rule_version: number;
  category_id: string;
  condition_ids: string[];
  price_ceiling_cents: number;
};

// The import's own query: packages/db no longer reads these two tables (spec 10.4).
const LEGACY_RULES = `SELECT r.segment, r.rule_kind, r.max_landed_cents, r.floor_cents, r.max_cents_per_gb,
    r.min_cents_per_gb, r.min_total_gb, r.sweep_q, r.candidate_cap_per_day, r.rule_version,
    f.category_id, f.condition_ids, f.price_ceiling_cents
  FROM app.segment_rule r JOIN app.feed f ON f.id = r.feed_id
  ORDER BY r.segment`;

const DESCRIPTION = "Imported from the MVP; describe the product before activating";

// Owner decision 10: imported products may take up to 20 candidates a day.
const IMPORTED_CANDIDATE_CAP = 20;

// "(a,b)" or "a", as the MVP's sweep query held them.
function searchWords(sweepQ: string): string[] {
  const inner = sweepQ.startsWith("(") && sweepQ.endsWith(")") ? sweepQ.slice(1, -1) : sweepQ;
  return inner.split(",").map((word) => word.trim());
}

function draftFields(row: LegacyRow, buyerProfile: BuyerProfile): Record<string, unknown> {
  const words = searchWords(row.sweep_q);
  const perGb = row.rule_kind === "per_gb";
  return {
    name: row.segment,
    description: DESCRIPTION,
    status: "draft",
    categoryId: row.category_id,
    conditionIds: row.condition_ids,
    searchWords: words,
    mustWords: [words],
    priceMode: "fixed",
    perGb,
    maxCents: perGb ? row.max_cents_per_gb : row.max_landed_cents,
    floorCents: perGb ? row.min_cents_per_gb : row.floor_cents,
    ...(perGb ? { unitMinTotal: row.min_total_gb } : {}),
    readCeilingCents: row.price_ceiling_cents,
    speed: "normal",
    priceDropCheck: true,
    candidateCapPerDay: Math.min(row.candidate_cap_per_day, IMPORTED_CANDIDATE_CAP),
    buyerProfile,
    alertRecipientIds: [],
  };
}

export type ImportedProduct = { product: StoredProduct; ruleVersion: number };

export type LegacyImportResult =
  | { ok: true; products: ImportedProduct[]; plan: DailyCallPlan | null }
  | { ok: false; reason: "products_exist"; count: number }
  | { ok: false; reason: "invalid"; key: string; issues: ProductIssue[] }
  // written: the keys saved before the refusal.
  | { ok: false; reason: "save_refused"; key: string; refusal: Exclude<ProductSaveResult, { ok: true }>; written: string[] };

// Each draft is saved in its own transaction. When a run failed after its first drafts, the next
// run saves the rest: it goes on while the products are only drafts of segment keys and the
// import has not finished (no import.legacy_products audit row). Anything else refuses.
export async function importLegacyProducts(pool: DbPool, ctx: ConfigContext): Promise<LegacyImportResult> {
  const rows = (await pool.query<LegacyRow>(LEGACY_RULES)).rows;
  const existing = await pool.query<{ key: string; status: string }>("SELECT key, status FROM app.product");
  const finished = await pool.query("SELECT 1 FROM app.audit_event WHERE action = 'import.legacy_products' LIMIT 1");
  const segments = new Set(rows.map((row) => row.segment));
  const ownDrafts = existing.rows.every((product) => product.status === "draft" && segments.has(product.key));
  if (existing.rows.length > 0 && (finished.rows.length > 0 || !ownDrafts)) {
    return { ok: false, reason: "products_exist", count: existing.rows.length };
  }
  const { settings } = await loadSettings(pool, ctx.env);
  const drafts = rows.map((row) => ({ row, fields: draftFields(row, settings.defaultBuyerProfile) }));
  // Every draft is checked before the first save, so an edited rule the product rules refuse
  // leaves the database as it was.
  for (const { row, fields } of drafts) {
    const parsed = parseProductRules(fields);
    if (!parsed.ok) return { ok: false, reason: "invalid", key: row.segment, issues: parsed.issues };
  }
  const products: ImportedProduct[] = [];
  let plan: DailyCallPlan | null = null;
  const earlier = await listProducts(pool);
  for (const { row, fields } of drafts) {
    const done = earlier.find((product) => product.key === row.segment);
    if (done !== undefined) {
      products.push({ product: done, ruleVersion: row.rule_version });
      continue;
    }
    const result = await saveProductWithPlan(pool, { kind: "create", key: row.segment, fields }, ctx);
    if (!result.ok) {
      return { ok: false, reason: "save_refused", key: row.segment, refusal: result, written: products.map((p) => p.product.key) };
    }
    products.push({ product: result.product, ruleVersion: row.rule_version });
    plan = result.plan;
  }
  await recordAuditEvent(pool, {
    at: ctx.at,
    actor: ctx.actor,
    action: "import.legacy_products",
    detail: { products: products.map(({ product, ruleVersion }) => ({ key: product.key, rule_version: ruleVersion })) },
  });
  return { ok: true, products, plan };
}
