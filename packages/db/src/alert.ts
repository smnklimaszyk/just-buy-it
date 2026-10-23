import type { BuyerProfile, Verdict } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

// Section 6.1. kind is always band, tier none and seq 1 in the MVP (one alert per item, Q6).
export type AlertInput = {
  itemKey: string;
  candidateId: string;
  screeningId: string | null;
  // The product key; rows written before v2 hold a segment.
  segment: string;
  finalVerdict: Verdict;
  modelVerdict: Verdict | null;
  blockedByCode: boolean;
  screened: boolean;
  flags: string[];
  priceCents: number;
  shippingCents: number | null;
  landedCents: number | null;
  ruleVersion: number;
  buyerProfile: BuyerProfile;
  createdAt: Date;
};

// Idempotent on (item_key, seq): a repeat (a retried job) returns the existing alert with
// created = false, and the caller makes no second delivery.
export async function insertAlert(db: Queryable, input: AlertInput): Promise<{ id: string; created: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO app.alert
       (item_key, seq, candidate_id, screening_id, kind, tier, segment, final_verdict, model_verdict, blocked_by_code,
        screened, flags, price_cents, shipping_cents, landed_cents, rule_version, buyer_profile, created_at)
     VALUES ($1, 1, $2, $3, 'band', 'none', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (item_key, seq) DO NOTHING
     RETURNING id`,
    [
      input.itemKey,
      input.candidateId,
      input.screeningId,
      input.segment,
      input.finalVerdict,
      input.modelVerdict,
      input.blockedByCode,
      input.screened,
      input.flags,
      input.priceCents,
      input.shippingCents,
      input.landedCents,
      input.ruleVersion,
      input.buyerProfile,
      input.createdAt,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id !== undefined) return { id, created: true };
  const existing = await db.query<{ id: string }>("SELECT id FROM app.alert WHERE item_key = $1 AND seq = 1", [input.itemKey]);
  const existingId = existing.rows[0]?.id;
  if (existingId === undefined) throw new Error("alert insert conflicted but no alert exists");
  return { id: existingId, created: false };
}
