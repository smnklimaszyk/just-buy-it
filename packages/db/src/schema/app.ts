import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { ts } from "../columns.js";
import { CONDITION_GROUPS, codeFormat, id, oneOf } from "./helpers.js";

export const app = pgSchema("app");

// One row per eBay pool and 24-hour window. Windows of one resource never overlap: the exclusion
// constraint is in migration 0001, because drizzle-kit cannot express EXCLUDE.
export const ebayQuotaWindow = app.table(
  "ebay_quota_window",
  {
    resource: text("resource").notNull(),
    windowStart: ts("window_start").notNull(),
    windowEnd: ts("window_end").notNull(),
    limitTotal: integer("limit_total").notNull().default(5000),
    used: integer("used").notNull().default(0),
    usedAlertPath: integer("used_alert_path").notNull().default(0),
    usedStandard: integer("used_standard").notNull().default(0),
    ebayOffset: integer("ebay_offset").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.resource, table.windowStart] }),
    check("ebay_quota_window_resource_format", sql`${table.resource} ~ '^[a-z]+\\.[a-z_.]+$'`),
    check("ebay_quota_window_bounds", sql`${table.windowEnd} > ${table.windowStart}`),
    check(
      "ebay_quota_window_counts",
      sql`${table.limitTotal} > 0 AND ${table.used} >= 0 AND ${table.ebayOffset} >= 0`,
    ),
    check("ebay_quota_window_used_sum", sql`${table.used} = ${table.usedAlertPath} + ${table.usedStandard}`),
  ],
);

export const apiUsageHourly = app.table(
  "api_usage_hourly",
  {
    hourUtc: ts("hour_utc").notNull(),
    resource: text("resource").notNull(),
    purpose: text("purpose").notNull(),
    calls: integer("calls").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hourUtc, table.resource, table.purpose] }),
    check("api_usage_hourly_purpose_format", sql`${table.purpose} ~ '^[a-z][a-z0-9_-]{0,39}$'`),
    check("api_usage_hourly_calls_positive", sql`${table.calls} > 0`),
    check("api_usage_hourly_whole_hour", sql`extract(epoch FROM ${table.hourUtc})::bigint % 3600 = 0`),
  ],
);

// ADR 0013: no username, userId, eiasToken or body.
export const deletionEvent = app.table(
  "deletion_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    notificationId: text("notification_id").notNull().unique(),
    topic: text("topic").notNull(),
    eventDate: ts("event_date").notNull(),
    publishAttemptCount: integer("publish_attempt_count").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("deletion_event_notification_id_length", sql`char_length(${table.notificationId}) BETWEEN 1 AND 128`),
    check("deletion_event_topic_length", sql`char_length(${table.topic}) BETWEEN 1 AND 64`),
    check("deletion_event_publish_attempt_count", sql`${table.publishAttemptCount} >= 0`),
  ],
);

export const deletionResultHourly = app.table(
  "deletion_result_hourly",
  {
    hourUtc: ts("hour_utc").notNull(),
    result: text("result").notNull(),
    notifications: integer("notifications").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hourUtc, table.result] }),
    check("deletion_result_hourly_result_format", sql`${table.result} ~ '^[a-z][a-z_]{0,39}$'`),
    check("deletion_result_hourly_notifications_positive", sql`${table.notifications} > 0`),
    check("deletion_result_hourly_whole_hour", sql`extract(epoch FROM ${table.hourUtc})::bigint % 3600 = 0`),
  ],
);

// One row, overwritten on each probe request (ADR 0030). seen_at comes from the server's clock.
export const probeSeen = app.table(
  "probe_seen",
  {
    id: smallint("id").primaryKey().default(1),
    seenAt: ts("seen_at").notNull(),
  },
  (table) => [check("probe_seen_single_row", sql`${table.id} = 1`)],
);

// ---- Listing pipeline (section 7.1). Config tables are changed by ops only. --------------------

// One feed per leaf category (ADR 0016). Seeded paused by migration 0006.
export const feed = app.table(
  "feed",
  {
    id: text("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    categoryId: text("category_id").notNull(),
    q: text("q").notNull(),
    // Read ceiling of the poll's price filter, about 1.5 x the typical asking price.
    priceCeilingCents: integer("price_ceiling_cents").notNull(),
    conditionIds: text("condition_ids").array().notNull(),
    dayIntervalS: integer("day_interval_s").notNull(),
    nightIntervalS: integer("night_interval_s").notNull(),
    overflowPagesPerDay: integer("overflow_pages_per_day").notNull().default(20),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // The MVP's feeds and segments, as migration 0004 checks them (spec 10.5). v2 reads neither table.
    check("feed_id_known", oneOf(table.id, ["gpu", "ram", "pc"])),
    check("feed_category_id_format", sql`${table.categoryId} ~ '^[0-9]{1,12}$'`),
    check("feed_price_ceiling_positive", sql`${table.priceCeilingCents} > 0`),
    check("feed_intervals", sql`${table.dayIntervalS} >= 60 AND ${table.nightIntervalS} >= 60`),
    check("feed_overflow_pages", sql`${table.overflowPagesPerDay} >= 0`),
  ],
);

// Owner-tunable price rules (section 3.3). Prices are integer cents against the landed price.
export const segmentRule = app.table(
  "segment_rule",
  {
    segment: text("segment").primaryKey(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feed.id),
    ruleKind: text("rule_kind").notNull(),
    maxLandedCents: integer("max_landed_cents"),
    floorCents: integer("floor_cents"),
    maxCentsPerGb: integer("max_cents_per_gb"),
    minCentsPerGb: integer("min_cents_per_gb"),
    minTotalGb: integer("min_total_gb"),
    sweepQ: text("sweep_q").notNull(),
    candidateCapPerDay: integer("candidate_cap_per_day").notNull().default(150),
    enabled: boolean("enabled").notNull().default(true),
    ruleVersion: integer("rule_version").notNull().default(1),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("segment_rule_segment_known", oneOf(table.segment, ["gpu_3090", "gpu_3090ti", "gpu_4090", "ram_ddr4", "ram_ddr5", "pc_4090"])),
    check("segment_rule_kind_known", oneOf(table.ruleKind, ["per_item", "per_gb"])),
    check(
      "segment_rule_per_item_fields",
      sql`${table.ruleKind} <> 'per_item' OR (${table.maxLandedCents} IS NOT NULL AND ${table.floorCents} IS NOT NULL AND ${table.floorCents} > 0 AND ${table.floorCents} <= ${table.maxLandedCents})`,
    ),
    check(
      "segment_rule_per_gb_fields",
      sql`${table.ruleKind} <> 'per_gb' OR (${table.maxCentsPerGb} IS NOT NULL AND ${table.minCentsPerGb} IS NOT NULL AND ${table.minTotalGb} IS NOT NULL AND ${table.minCentsPerGb} > 0 AND ${table.minCentsPerGb} <= ${table.maxCentsPerGb} AND ${table.minTotalGb} > 0)`,
    ),
    check("segment_rule_cap", sql`${table.candidateCapPerDay} >= 0`),
    check("segment_rule_version_positive", sql`${table.ruleVersion} >= 1`),
  ],
);

// One row per item key ever seen (90 days after the last sighting). No item ID, title or price.
export const seenItem = app.table(
  "seen_item",
  {
    itemKey: text("item_key").primaryKey(),
    keyVersion: smallint("key_version").notNull(),
    feedId: text("feed_id").notNull(),
    segment: text("segment"),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    candidateAt: ts("candidate_at"),
    // candidate, baseline, too_old, over_cap, or a classifier reason code.
    outcome: text("outcome").notNull(),
  },
  (table) => [
    index("seen_item_feed_id_idx").on(table.feedId),
    check("seen_item_item_key_format", sql`${table.itemKey} ~ '^[0-9a-f]{64}$'`),
    check("seen_item_outcome_format", codeFormat(table.outcome)),
  ],
);

// Metadata of qualifying listings at their first poll sighting, for the price read (section 3.5).
// No item key, item ID, title or seller.
export const priceSample = app.table(
  "price_sample",
  {
    id: id(),
    segment: text("segment").notNull(),
    feedId: text("feed_id").notNull(),
    priceCents: integer("price_cents").notNull(),
    shippingCents: integer("shipping_cents"),
    // NULL when shipping is unknown: unknown shipping is never counted as zero.
    landedCents: integer("landed_cents"),
    totalGb: integer("total_gb"),
    seenAt: ts("seen_at").notNull(),
  },
  (table) => [index("price_sample_segment_seen_at_idx").on(table.segment, table.seenAt)],
);

// One row per poll or sweep run, inserted as running before the first request (section 2.3).
export const pollRun = app.table(
  "poll_run",
  {
    id: id(),
    feedId: text("feed_id").notNull(),
    // Set for sweeps only.
    segment: text("segment"),
    kind: text("kind").notNull(),
    baseline: boolean("baseline").notNull().default(false),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
    status: text("status").notNull().default("running"),
    pages: integer("pages").notNull().default(0),
    items: integer("items").notNull().default(0),
    malformed: integer("malformed").notNull().default(0),
    newItems: integer("new_items").notNull().default(0),
    candidates: integer("candidates").notNull().default(0),
    capReached: boolean("cap_reached").notNull().default(false),
    warningIds: integer("warning_ids").array().notNull().default(sql`'{}'::integer[]`),
    errorKind: text("error_kind"),
    calls: integer("calls").notNull().default(0),
  },
  (table) => [
    index("poll_run_feed_kind_started_idx").on(table.feedId, table.kind, table.startedAt.desc()),
    index("poll_run_segment_kind_started_idx").on(table.segment, table.kind, table.startedAt.desc()),
    check("poll_run_kind_known", oneOf(table.kind, ["poll", "sweep"])),
    check("poll_run_segment_for_sweeps", sql`(${table.kind} = 'sweep') = (${table.segment} IS NOT NULL)`),
    check("poll_run_status_known", oneOf(table.status, ["running", "ok", "error", "quota_refused", "paused"])),
    check("poll_run_finished_unless_running", sql`(${table.status} = 'running') = (${table.finishedAt} IS NULL)`),
    check(
      "poll_run_error_kind_known",
      sql`${table.errorKind} IS NULL OR ${oneOf(table.errorKind, ["timeout", "network", "http_5xx", "invalid_response", "deadline", "db"])}`,
    ),
    check(
      "poll_run_counts",
      sql`${table.pages} >= 0 AND ${table.items} >= 0 AND ${table.malformed} >= 0 AND ${table.newItems} >= 0 AND ${table.candidates} >= 0 AND ${table.calls} >= 0`,
    ),
  ],
);

// One row per item that became a candidate (once per item, Q6). listing_id is a plain uuid: no
// foreign key into ebay_live. Prices are set to NULL after 30 days.
export const candidate = app.table(
  "candidate",
  {
    id: id(),
    itemKey: text("item_key").notNull().unique(),
    listingId: uuid("listing_id").notNull().unique(),
    feedId: text("feed_id").notNull(),
    segment: text("segment").notNull(),
    source: text("source").notNull(),
    priceCents: integer("price_cents"),
    shippingCents: integer("shipping_cents"),
    landedCents: integer("landed_cents"),
    shippingKnown: boolean("shipping_known").notNull(),
    // RAM segments: the parsed total size, for the per-GB rule.
    totalGb: integer("total_gb"),
    ruleVersion: integer("rule_version").notNull(),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    // Section 5.6 code signals of the getItem title and raw description, set by enrich before the
    // description is masked. The screen job reads them.
    codeSignals: text("code_signals").array().notNull().default(sql`'{}'::text[]`),
    decision: text("decision").notNull().default("pending"),
    rejectReason: text("reject_reason"),
    enrichStartedAt: ts("enrich_started_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    // v2 (spec 2.8, migration 0010). NULL on rows Release 0 wrote.
    productVersion: integer("product_version"),
    matchVersion: integer("match_version"),
    conditionGroup: text("condition_group"),
    // The limit the candidate passed: max_cents, or the market limit below the cap.
    limitCents: integer("limit_cents"),
    priceMode: text("price_mode"),
    marketValueId: uuid("market_value_id"),
    // Written by enrich at hand-off; screen and its retry use them (spec 4.5).
    promptVersion: text("prompt_version"),
    model: text("model"),
    effort: text("effort"),
    heldReason: text("held_reason"),
  },
  (table) => [
    index("candidate_segment_created_idx").on(table.segment, table.createdAt.desc()),
    check("candidate_source_known", oneOf(table.source, ["poll", "sweep"])),
    check(
      "candidate_decision_known",
      // wrong_product and held widened in migration 0010 (spec 2.9).
      oneOf(table.decision, [
        "pending",
        "alerted",
        "blocked",
        "rejected_after_enrich",
        "gone",
        "expired",
        "wrong_product",
        "held",
      ]),
    ),
    check("candidate_reject_reason_format", sql`${table.rejectReason} IS NULL OR ${codeFormat(table.rejectReason)}`),
    check("candidate_price_mode_known", sql`${table.priceMode} IS NULL OR ${oneOf(table.priceMode, ["fixed", "below_market"])}`),
    check(
      "candidate_condition_group_known",
      sql`${table.conditionGroup} IS NULL OR ${oneOf(table.conditionGroup, CONDITION_GROUPS)}`,
    ),
    check("candidate_held_reason_format", sql`${table.heldReason} IS NULL OR ${codeFormat(table.heldReason)}`),
    check(
      "candidate_versions_positive",
      sql`(${table.productVersion} IS NULL OR ${table.productVersion} >= 1) AND (${table.matchVersion} IS NULL OR ${table.matchVersion} >= 1)`,
    ),
    check("candidate_limit_positive", sql`${table.limitCents} IS NULL OR ${table.limitCents} > 0`),
  ],
);

// One claim row per (item key, prompt version): at most 2 paid attempts (section 2.4).
export const screening = app.table(
  "screening",
  {
    id: id(),
    itemKey: text("item_key").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(),
    attempt: smallint("attempt").notNull().default(1),
    leaseUntil: ts("lease_until"),
    verdict: text("verdict"),
    productMatch: text("product_match"),
    riskFlags: text("risk_flags").array().notNull().default(sql`'{}'::text[]`),
    codeSignals: text("code_signals").array().notNull().default(sql`'{}'::text[]`),
    failureCode: text("failure_code"),
    requestBytes: integer("request_bytes"),
    // Sums over the attempts of this claim: every call that reached Anthropic counts.
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicrousd: integer("cost_microusd"),
    reservedMicrousd: integer("reserved_microusd"),
    latencyMs: integer("latency_ms"),
    inferenceGeo: text("inference_geo"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("screening_item_key_prompt_version_unique").on(table.itemKey, table.promptVersion),
    check("screening_status_known", oneOf(table.status, ["running", "done", "failed", "skipped"])),
    check("screening_attempt_range", sql`${table.attempt} BETWEEN 1 AND 2`),
    check("screening_verdict_known", sql`${table.verdict} IS NULL OR ${oneOf(table.verdict, ["pass", "caution", "block"])}`),
    check(
      "screening_product_match_known",
      sql`${table.productMatch} IS NULL OR ${oneOf(table.productMatch, ["match", "mismatch", "unclear"])}`,
    ),
    check("screening_failure_code_format", sql`${table.failureCode} IS NULL OR ${codeFormat(table.failureCode)}`),
    check("screening_done_has_verdict", sql`${table.status} <> 'done' OR ${table.verdict} IS NOT NULL`),
  ],
);

// One row: screening pauses for all listings until this time after auth_failed.
export const screeningPause = app.table(
  "screening_pause",
  {
    id: smallint("id").primaryKey().default(1),
    until: ts("until").notNull(),
  },
  (table) => [check("screening_pause_single_row", sql`${table.id} = 1`)],
);

// Claude calls and spend per Berlin day, reserved before each call (section 5.5).
export const llmUsageDaily = app.table(
  "llm_usage_daily",
  {
    dayBerlin: date("day_berlin", { mode: "string" }).primaryKey(),
    calls: integer("calls").notNull().default(0),
    reservedMicrousd: bigint("reserved_microusd", { mode: "number" }).notNull().default(0),
    spentMicrousd: bigint("spent_microusd", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    check(
      "llm_usage_daily_counts",
      sql`${table.calls} >= 0 AND ${table.reservedMicrousd} >= 0 AND ${table.spentMicrousd} >= 0`,
    ),
  ],
);

// Claude calls per product and Berlin day, counted with the daily row, for the per-product share
// of spec 4.4. product_key is app.product.key. Kept 30 days.
export const llmUsageProductDaily = app.table(
  "llm_usage_product_daily",
  {
    dayBerlin: date("day_berlin", { mode: "string" }).notNull(),
    productKey: text("product_key").notNull(),
    calls: integer("calls").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.dayBerlin, table.productKey] }),
    check("llm_usage_product_daily_calls", sql`${table.calls} >= 0`),
  ],
);

// One alert per item and seq (seq is always 1 in the MVP). kind and tier use the ADR 0015 enums.
export const alert = app.table(
  "alert",
  {
    id: id(),
    itemKey: text("item_key").notNull(),
    seq: smallint("seq").notNull().default(1),
    candidateId: uuid("candidate_id").notNull(),
    screeningId: uuid("screening_id"),
    kind: text("kind").notNull().default("band"),
    tier: text("tier").notNull().default("none"),
    segment: text("segment").notNull(),
    finalVerdict: text("final_verdict").notNull(),
    modelVerdict: text("model_verdict"),
    blockedByCode: boolean("blocked_by_code").notNull(),
    screened: boolean("screened").notNull(),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    priceCents: integer("price_cents"),
    shippingCents: integer("shipping_cents"),
    landedCents: integer("landed_cents"),
    ruleVersion: integer("rule_version").notNull(),
    buyerProfile: text("buyer_profile").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("alert_item_key_seq_unique").on(table.itemKey, table.seq),
    check("alert_seq_positive", sql`${table.seq} >= 1`),
    check("alert_kind_known", oneOf(table.kind, ["band", "instant", "auction_bid", "trial"])),
    check("alert_tier_known", oneOf(table.tier, ["none", "no_brainer", "good", "fair", "above_market", "unrated"])),
    check("alert_final_verdict_known", oneOf(table.finalVerdict, ["pass", "caution", "block"])),
    check(
      "alert_model_verdict_known",
      sql`${table.modelVerdict} IS NULL OR ${oneOf(table.modelVerdict, ["pass", "caution", "block"])}`,
    ),
    check("alert_buyer_profile_known", oneOf(table.buyerProfile, ["company", "private"])),
  ],
);

// One delivery per alert and recipient. attempt counts real SMTP attempts only (section 2.4).
export const alertDelivery = app.table(
  "alert_delivery",
  {
    id: id(),
    alertId: uuid("alert_id").notNull(),
    channel: text("channel").notNull().default("email"),
    recipient: text("recipient").notNull(),
    status: text("status").notNull().default("pending"),
    holdReason: text("hold_reason"),
    attempt: smallint("attempt").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull(),
    leaseUntil: ts("lease_until"),
    lastErrorCode: text("last_error_code"),
    smtpMessageId: text("smtp_message_id"),
    sentAt: ts("sent_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("alert_delivery_alert_recipient_unique").on(table.alertId, table.recipient),
    index("alert_delivery_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    check("alert_delivery_channel_known", oneOf(table.channel, ["email"])),
    check("alert_delivery_status_known", oneOf(table.status, ["pending", "sending", "sent", "failed", "expired"])),
    check(
      "alert_delivery_hold_reason_known",
      sql`${table.holdReason} IS NULL OR ${oneOf(table.holdReason, ["smtp_not_configured", "smtp_paused", "rate_limit"])}`,
    ),
    check("alert_delivery_attempt_range", sql`${table.attempt} BETWEEN 0 AND 5`),
    check("alert_delivery_sent_at", sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`),
  ],
);

// One row: every send is held until this time after an SMTP authentication failure.
export const smtpPause = app.table(
  "smtp_pause",
  {
    id: smallint("id").primaryKey().default(1),
    until: ts("until").notNull(),
  },
  (table) => [check("smtp_pause_single_row", sql`${table.id} = 1`)],
);

// One row per purge run, with numbers per step (never content).
export const purgeRun = app.table(
  "purge_run",
  {
    id: id(),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
    status: text("status").notNull(),
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [check("purge_run_status_known", oneOf(table.status, ["ok", "error"]))],
);

// One row, overwritten by the worker at start and on every heartbeat.
export const workerStatus = app.table(
  "worker_status",
  {
    id: smallint("id").primaryKey().default(1),
    gitSha: text("git_sha").notNull(),
    startedAt: ts("started_at").notNull(),
    heartbeatAt: ts("heartbeat_at").notNull(),
    smtpConfigured: boolean("smtp_configured").notNull(),
    claudeConfigured: boolean("claude_configured").notNull(),
  },
  (table) => [check("worker_status_single_row", sql`${table.id} = 1`)],
);

// Every ops edit (section 1.2 S2). detail never carries a secret.
export const auditEvent = app.table(
  "audit_event",
  {
    id: id(),
    at: ts("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    // Widened in migration 0010 so user:<uuid> fits (spec 2.9).
    check("audit_event_actor_format", sql`${table.actor} ~ '^[a-z]+:[a-z0-9_-]{1,40}$'`),
    check("audit_event_action_format", sql`${table.action} ~ '^[a-z][a-z0-9_.]{0,63}$'`),
  ],
);
