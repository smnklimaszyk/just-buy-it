import { FEED_IDS, SEGMENTS, type FeedConfig, type FeedId, type Segment, type SegmentRule } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

type FeedRow = {
  id: FeedId;
  enabled: boolean;
  category_id: string;
  q: string;
  price_ceiling_cents: number;
  condition_ids: string[];
  day_interval_s: number;
  night_interval_s: number;
  overflow_pages_per_day: number;
};

const FEED_COLUMNS =
  "id, enabled, category_id, q, price_ceiling_cents, condition_ids, day_interval_s, night_interval_s, overflow_pages_per_day";

function toFeed(row: FeedRow): FeedConfig {
  return {
    id: row.id,
    enabled: row.enabled,
    categoryId: row.category_id,
    q: row.q,
    priceCeilingCents: row.price_ceiling_cents,
    conditionIds: row.condition_ids,
    dayIntervalS: row.day_interval_s,
    nightIntervalS: row.night_interval_s,
    overflowPagesPerDay: row.overflow_pages_per_day,
  };
}

// In the order of FEED_IDS.
export async function listFeeds(db: Queryable): Promise<FeedConfig[]> {
  const result = await db.query<FeedRow>(
    `SELECT ${FEED_COLUMNS} FROM app.feed ORDER BY array_position($1::text[], id)`,
    [FEED_IDS],
  );
  return result.rows.map(toFeed);
}

type RuleRow = {
  segment: Segment;
  feed_id: FeedId;
  rule_kind: "per_item" | "per_gb";
  max_landed_cents: number | null;
  floor_cents: number | null;
  max_cents_per_gb: number | null;
  min_cents_per_gb: number | null;
  min_total_gb: number | null;
  sweep_q: string;
  candidate_cap_per_day: number;
  enabled: boolean;
  rule_version: number;
};

const RULE_COLUMNS =
  "segment, feed_id, rule_kind, max_landed_cents, floor_cents, max_cents_per_gb, min_cents_per_gb, min_total_gb, sweep_q, candidate_cap_per_day, enabled, rule_version";

// The check constraints of segment_rule guarantee the fields of each kind are set.
function toRule(row: RuleRow): SegmentRule {
  const base = {
    segment: row.segment,
    feedId: row.feed_id,
    sweepQ: row.sweep_q,
    candidateCapPerDay: row.candidate_cap_per_day,
    enabled: row.enabled,
    ruleVersion: row.rule_version,
  };
  if (row.rule_kind === "per_item") {
    return { ...base, kind: "per_item", maxLandedCents: row.max_landed_cents ?? 0, floorCents: row.floor_cents ?? 0 };
  }
  return {
    ...base,
    kind: "per_gb",
    maxCentsPerGb: row.max_cents_per_gb ?? 0,
    minCentsPerGb: row.min_cents_per_gb ?? 0,
    minTotalGb: row.min_total_gb ?? 0,
  };
}

// In the order of SEGMENTS.
export async function listSegmentRules(db: Queryable): Promise<SegmentRule[]> {
  const result = await db.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM app.segment_rule ORDER BY array_position($1::text[], segment)`,
    [SEGMENTS],
  );
  return result.rows.map(toRule);
}

export type AuditInput = { at: Date; actor: string; action: string };

const RULE_FIELDS = {
  maxLandedCents: "max_landed_cents",
  floorCents: "floor_cents",
  maxCentsPerGb: "max_cents_per_gb",
  minCentsPerGb: "min_cents_per_gb",
  minTotalGb: "min_total_gb",
  sweepQ: "sweep_q",
  candidateCapPerDay: "candidate_cap_per_day",
  enabled: "enabled",
} as const;

export type SegmentRulePatch = {
  maxLandedCents?: number;
  floorCents?: number;
  maxCentsPerGb?: number;
  minCentsPerGb?: number;
  minTotalGb?: number;
  sweepQ?: string;
  candidateCapPerDay?: number;
  enabled?: boolean;
};

const FEED_FIELDS = {
  enabled: "enabled",
  categoryId: "category_id",
  q: "q",
  priceCeilingCents: "price_ceiling_cents",
  dayIntervalS: "day_interval_s",
  nightIntervalS: "night_interval_s",
  overflowPagesPerDay: "overflow_pages_per_day",
} as const;

export type FeedPatch = {
  enabled?: boolean;
  categoryId?: string;
  q?: string;
  priceCeilingCents?: number;
  dayIntervalS?: number;
  nightIntervalS?: number;
  overflowPagesPerDay?: number;
};

// One statement: the change and its audit_event row are written together or not at all (a check
// constraint that fails refuses both). Column names come from the fixed field maps above.
async function patchWithAudit<Row extends object>(
  db: Queryable,
  options: {
    table: "app.feed" | "app.segment_rule";
    keyColumn: "id" | "segment";
    key: string;
    columns: [string, unknown][];
    bumpVersion: boolean;
    returning: string;
    audit: AuditInput;
  },
): Promise<Row | null> {
  if (options.columns.length === 0) throw new Error("the patch changes nothing");
  const { keyColumn: k, columns } = options;
  const values = columns.map(([, value]) => value);
  const sets = columns.map(([column], i) => `${column} = $${i + 5}`);
  if (options.bumpVersion) sets.push("rule_version = t.rule_version + 1");
  sets.push("updated_at = $2");
  const changes = columns
    .map(([column]) => `'${column}', jsonb_build_object('from', old.${column}, 'to', upd.${column})`)
    .join(", ");
  const version = options.bumpVersion
    ? `, 'rule_version', jsonb_build_object('from', old.rule_version, 'to', upd.rule_version)`
    : "";
  const result = await db.query<Row>(
    `WITH old AS (SELECT * FROM ${options.table} WHERE ${k} = $1 FOR UPDATE),
     upd AS (
       UPDATE ${options.table} t SET ${sets.join(", ")}
         FROM old WHERE t.${k} = old.${k}
       RETURNING t.*
     ),
     audit AS (
       INSERT INTO app.audit_event (at, actor, action, detail)
       SELECT $2, $3, $4, jsonb_build_object('${k === "id" ? "feed" : "segment"}', upd.${k}${version}, 'changes', jsonb_build_object(${changes}))
         FROM old JOIN upd ON upd.${k} = old.${k}
     )
     SELECT ${options.returning} FROM upd`,
    [options.key, options.audit.at, options.audit.actor, options.audit.action, ...values],
  );
  return result.rows[0] ?? null;
}

function patchColumns(patch: object, fields: Record<string, string>): [string, unknown][] {
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => {
      const column = fields[field];
      if (column === undefined) throw new Error(`unknown field ${field}`);
      return [column, value];
    });
}

// `ops rules set`: changes a segment's rule, bumps rule_version and writes audit_event. Returns
// null for an unknown segment (nothing written).
export async function updateSegmentRule(
  db: Queryable,
  segment: Segment,
  patch: SegmentRulePatch,
  audit: AuditInput,
): Promise<SegmentRule | null> {
  const row = await patchWithAudit<RuleRow>(db, {
    table: "app.segment_rule",
    keyColumn: "segment",
    key: segment,
    columns: patchColumns(patch, RULE_FIELDS),
    bumpVersion: true,
    returning: RULE_COLUMNS,
    audit,
  });
  return row === null ? null : toRule(row);
}

// `ops feeds pause|resume|set`: changes a feed and writes audit_event. Returns null for an unknown
// feed (nothing written).
export async function updateFeed(
  db: Queryable,
  id: FeedId,
  patch: FeedPatch,
  audit: AuditInput,
): Promise<FeedConfig | null> {
  const row = await patchWithAudit<FeedRow>(db, {
    table: "app.feed",
    keyColumn: "id",
    key: id,
    columns: patchColumns(patch, FEED_FIELDS),
    bumpVersion: false,
    returning: FEED_COLUMNS,
    audit,
  });
  return row === null ? null : toFeed(row);
}
