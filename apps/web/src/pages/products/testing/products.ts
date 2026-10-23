import { randomBytes } from "node:crypto";
import { saveProductWithPlan, type StoredProduct } from "@ebay-sniper/db";
import type { ConditionGroup, MarketValueStatus } from "@ebay-sniper/domain";
import type { Harness } from "../../../testing/harness.js";

// Test helpers, not built: products and the rows the worker writes about them, arranged the way
// the stores and the worker write them.

// A non-hardware example product (spec 3.5), used fixed price for Canon EF.
export const LENS = {
  name: "Portrait lens",
  description: "Used 85 mm portrait lens for Canon EF. Not a lens hood, not a teleconverter.",
  status: "active",
  categoryId: "3323",
  conditionIds: ["2750", "3000", "4000", "5000", "6000"],
  searchWords: ["85mm", "portraitobjektiv"],
  mustWords: [["85mm", "portraitobjektiv"]],
  excludeWords: ["defekt*"],
  priceMode: "fixed",
  maxCents: 45_000,
  buyerProfile: "company",
} as const;

export async function seedProduct(h: Harness, fields: Record<string, unknown> = {}): Promise<StoredProduct> {
  const result = await saveProductWithPlan(
    h.db.admin,
    { kind: "create", fields: { ...LENS, ...fields } },
    { at: h.clock.now(), actor: "system:cli", userId: null, env: h.deps.settingsEnv },
  );
  if (!result.ok) throw new Error(`seed product refused: ${JSON.stringify(result)}`);
  return result.product;
}

export const itemKey = (): string => randomBytes(32).toString("hex");

export type SeedValue = {
  group: ConditionGroup;
  status: MarketValueStatus;
  valueCents: number | null;
  computedAt: Date;
  matchVersion?: number;
  n?: number;
  neff?: number;
  p25Cents?: number;
  p75Cents?: number;
  halfWidth?: number;
  bestOfferShare?: number;
  capped?: boolean;
  counts?: Record<string, number>;
};

export async function seedMarketValue(h: Harness, product: StoredProduct, value: SeedValue): Promise<string> {
  const result = await h.db.admin.query<{ id: string }>(
    `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
       n, neff, m_cents, p25_cents, p75_cents, lo_cents, hi_cents, half_width, best_offer_share, value_cents, counts)
     VALUES ($1, $2, $3, $4, 'mv-1', $5, $6, $7, $8, $9, $10, $11, $9, $9, $12, $13, $9, $14) RETURNING id`,
    [
      product.id,
      value.group,
      value.matchVersion ?? product.matchVersion,
      value.computedAt,
      value.status,
      value.capped ?? false,
      value.n ?? 20,
      value.neff ?? 18,
      value.valueCents,
      value.p25Cents ?? null,
      value.p75Cents ?? null,
      value.halfWidth ?? null,
      value.bestOfferShare ?? null,
      JSON.stringify(value.counts ?? {}),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no market value stored");
  return id;
}

export type SeedCandidate = {
  decision: string;
  createdAt: Date;
  title?: string;
  legacyItemId?: string;
  landedCents?: number;
  limitCents?: number;
  heldReason?: string;
  claudeReason?: string;
  productMatch?: "match" | "mismatch" | "unclear";
  verdict?: "pass" | "caution" | "block";
};

// A candidate with its listing and, when a title is given, the listing's content; with a Claude
// reason also the screening and its reason text.
export async function seedCandidate(h: Harness, product: StoredProduct, row: SeedCandidate): Promise<string> {
  const key = itemKey();
  const listing = await h.db.admin.query<{ id: string }>(
    `INSERT INTO ebay_live.listing (item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at, last_confirmed_at,
       content_expires_at)
     VALUES ($1, 1, $2, $3, 's1', $4, $5, $5, $5::timestamptz + interval '6 hours') RETURNING id`,
    [key, `v1|${row.legacyItemId ?? "100200300400"}|0`, row.legacyItemId ?? "100200300400", product.key, row.createdAt],
  );
  const listingId = listing.rows[0]?.id;
  if (listingId === undefined) throw new Error("no listing stored");
  if (row.title !== undefined) {
    await h.db.admin.query(
      `INSERT INTO ebay_live.listing_content (listing_id, source, title, fetched_at, content_expires_at)
       VALUES ($1, 'item', $2, $3, $3::timestamptz + interval '6 hours')`,
      [listingId, row.title, row.createdAt],
    );
  }
  const candidate = await h.db.admin.query<{ id: string }>(
    `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, landed_cents, shipping_known, rule_version,
       decision, created_at, limit_cents, held_reason, prompt_version, product_version, match_version)
     VALUES ($1, $2, 's1', $3, 'poll', $4, true, 1, $5, $6, $7, $8, 'p2-test', $9, $10) RETURNING id`,
    [
      key,
      listingId,
      product.key,
      row.landedCents ?? 40_000,
      row.decision,
      row.createdAt,
      row.limitCents ?? null,
      row.heldReason ?? null,
      product.version,
      product.matchVersion,
    ],
  );
  const id = candidate.rows[0]?.id;
  if (id === undefined) throw new Error("no candidate stored");
  if (row.claudeReason !== undefined) {
    const screening = await h.db.admin.query<{ id: string }>(
      `INSERT INTO app.screening (item_key, prompt_version, model, status, verdict, product_match, created_at, updated_at)
       VALUES ($1, 'p2-test', 'claude-sonnet-5-5', 'done', $2, $3, $4, $4) RETURNING id`,
      [key, row.verdict ?? "pass", row.productMatch ?? "match", row.createdAt],
    );
    await h.db.admin.query(
      "INSERT INTO ebay_live.screening_text (screening_id, reason, expires_at) VALUES ($1, $2, $3::timestamptz + interval '6 hours')",
      [screening.rows[0]?.id, row.claudeReason, row.createdAt],
    );
  }
  return id;
}

export async function seedAlert(h: Harness, product: StoredProduct, candidateId: string, createdAt: Date): Promise<void> {
  await h.db.admin.query(
    `INSERT INTO app.alert (item_key, candidate_id, segment, final_verdict, blocked_by_code, screened, rule_version, buyer_profile, created_at)
     SELECT item_key, id, segment, 'pass', false, true, 1, 'company', $2 FROM app.candidate WHERE id = $1`,
    [candidateId, createdAt],
  );
}
