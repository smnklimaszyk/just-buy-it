import {
  countScreensInFlight,
  getCandidateByListingId,
  getListing,
  insertAlert,
  insertAlertMessage,
  insertDelivery,
  listSegmentRules,
  llmSlotAvailable,
  markEnrichStarted,
  markListingGone,
  RELAY_LOST_AFTER_MS,
  screeningPausedUntil,
  setCandidateDecision,
  updateCandidateAfterEnrich,
  upsertListingContent,
  type DbPool,
  type Candidate,
  type EnrichedCandidate,
  type GoneReason,
  type Listing,
  type ListingContentInput,
  type LlmCapCode,
  type Queryable,
} from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import {
  berlinDay,
  checkPriceBand,
  classifyAfterEnrich,
  cleanDescription,
  contentExpiresAt,
  finalVerdict,
  isKnownSegment,
  LISTING_FLAGS,
  routeAlert,
  scanListing,
  segmentInfo,
  toListingCandidate,
  type BuyerProfile,
  type Clock,
  type CodeSignal,
  type ListingFlag,
  type RejectReason,
  type Segment,
  type SegmentRule,
  type Verdict,
} from "@ebay-sniper/domain";
import { EbayError, endUserContext, type BrowseCallContext, type GetItemRequest, type GetItemResult, type Item } from "@ebay-sniper/ebay";
import {
  MAX_ITEM_SPECIFICS,
  MAX_SPECIFIC_NAME_CHARS,
  MAX_SPECIFIC_VALUE_CHARS,
  PROMPT_VERSION,
  WORST_CASE_COST_MICROUSD,
  type ClaudeScreener,
} from "@ebay-sniper/llm";
import { renderAlertEmail, type AlertScreening } from "@ebay-sniper/notify";
import { inTransaction, type LogFn } from "./poll.js";

export type GetItemFn = (itemId: string, request: GetItemRequest, call: BrowseCallContext) => Promise<GetItemResult>;

// Screening is configured when there is a screener (ANTHROPIC_API_KEY set); both caps per Berlin day.
export type ClaudeSettings = {
  screener: ClaudeScreener | null;
  callLimit: number;
  spendLimitMicrousd: number;
};

// What the enrich and screen jobs need to make an alert.
export type AlertDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  alerts: { recipient: string; buyerProfile: BuyerProfile };
  log: { info: LogFn; warn: LogFn };
};

export type EnrichDeps = AlertDeps & {
  getItem: GetItemFn;
  postalCode: string;
  claude: ClaudeSettings;
};

// A candidate whose segment this release knows.
export type KnownCandidate = Candidate & { segment: Segment };

// v2 writes product keys such as p_k3x9ab2cde where a segment stood, and this release has no rule
// for them. Such a candidate ends expired with reason unknown_segment and null comes back; relay
// never queues an ended candidate again.
export async function knownCandidate(db: Queryable, candidate: Candidate): Promise<KnownCandidate | null> {
  const { segment } = candidate;
  if (isKnownSegment(segment)) return { ...candidate, segment };
  await setCandidateDecision(db, candidate.id, { decision: "expired", rejectReason: "unknown_segment" });
  return null;
}

export type AlertSource = {
  candidate: KnownCandidate;
  listing: Listing;
  // getItem content, or the summary content for an alert made without getItem.
  content: ListingContentInput;
  rule: SegmentRule;
  screening: AlertScreening;
  screeningId: string | null;
  codeSignals: CodeSignal[];
};

// The rule the alert names. Migration 0006 seeds one per segment, so a missing one is a fault.
export async function segmentRule(db: Queryable, segment: Segment): Promise<SegmentRule> {
  const rule = (await listSegmentRules(db)).find((r) => r.segment === segment);
  if (rule === undefined) throw new Error(`segment ${segment} has no rule`);
  return rule;
}

// Section 6.1, inside the screen or enrich result transaction: the alert, and unless a code scam
// floor fired, one delivery for ALERT_TO with its rendered message and the send job.
export async function createAlert(
  deps: AlertDeps,
  client: Queryable,
  source: AlertSource,
  now: Date,
): Promise<AlertCreated | null> {
  const { candidate } = source;
  if (candidate.priceCents === null) throw new Error("candidate has no price");
  const screening = source.screening;
  const verdict = finalVerdict(screening, source.codeSignals);
  const alert = await insertAlert(client, {
    itemKey: candidate.itemKey,
    candidateId: candidate.id,
    screeningId: source.screeningId,
    segment: candidate.segment,
    finalVerdict: verdict.finalVerdict,
    modelVerdict: verdict.modelVerdict,
    blockedByCode: verdict.blockedByCode,
    screened: verdict.screened,
    flags: candidate.flags,
    priceCents: candidate.priceCents,
    shippingCents: candidate.shippingCents,
    landedCents: candidate.landedCents,
    ruleVersion: candidate.ruleVersion,
    buyerProfile: deps.alerts.buyerProfile,
    createdAt: now,
  });
  // A repeat (a second or retried job) finds the alert and makes nothing more.
  if (!alert.created) return null;
  // Section 5.7: a code-verified scam floor keeps the alert on the dashboard only.
  const route = routeAlert(verdict);
  await setCandidateDecision(client, candidate.id, { decision: route.sendEmail ? "alerted" : "blocked", rejectReason: null });
  const created = { alertId: alert.id, finalVerdict: verdict.finalVerdict, blockedByCode: verdict.blockedByCode };
  if (!route.sendEmail) return created;
  const deliveryId = await insertDelivery(client, { alertId: alert.id, recipient: deps.alerts.recipient, now });
  const { listing, content } = source;
  const email = renderAlertEmail({
    deliveryId,
    rule: source.rule,
    buyerProfile: deps.alerts.buyerProfile,
    legacyItemId: listing.legacyItemId,
    title: content.title,
    asOf: content.fetchedAt,
    priceCents: candidate.priceCents,
    shippingCents: candidate.shippingCents,
    totalGb: candidate.totalGb,
    condition: content.condition,
    seller: {
      accountType: content.sellerAccountType,
      feedbackScore: content.sellerFeedbackScore,
      feedbackPercent: content.sellerFeedbackPct,
    },
    // A summary-only alert says "Returns: not fetched"; getItem content has the return terms.
    returns: content.source === "item" ? { accepted: content.returnsAccepted, periodDays: content.returnsDays } : null,
    flags: candidate.flags,
    descriptionText: content.descriptionText,
    screening: source.screening,
    // The renderer labels the email from the same verdict inputs.
    codeSignals: source.codeSignals,
  });
  await insertAlertMessage(client, {
    deliveryId,
    subject: email.subject,
    textBody: email.text,
    htmlBody: email.html,
    expiresAt: content.contentExpiresAt,
  });
  // On the transaction's client: a rollback leaves no job.
  await deps.queue.send("send", { deliveryId }, { db: client });
  return created;
}

export type AlertCreated = { alertId: string; finalVerdict: Verdict; blockedByCode: boolean };

// Logged after the commit, so the line never names an alert that was rolled back.
export function logAlertCreated(deps: AlertDeps, created: AlertCreated): void {
  deps.log.info({
    event: "alert_created",
    alert_id: created.alertId,
    final_verdict: created.finalVerdict,
    blocked_by_code: created.blockedByCode,
  });
}

// Read-only (section 2.4): configured, not paused, and the day leaves room for one worst-case call
// under both caps, after the candidates already past getItem that wait for their screen. The
// screen job makes the reservation. This keeps getItem within the Claude call cap (section 3.4).
async function claudeSlot(deps: EnrichDeps, now: Date): Promise<"ok" | "not_configured" | "paused" | LlmCapCode> {
  if (deps.claude.screener === null) return "not_configured";
  if ((await screeningPausedUntil(deps.pool, now)) !== null) return "paused";
  const inFlight = await countScreensInFlight(deps.pool, PROMPT_VERSION);
  return llmSlotAvailable(
    deps.pool,
    {
      day: berlinDay(now),
      worstMicrousd: WORST_CASE_COST_MICROUSD,
      callLimit: deps.claude.callLimit,
      spendLimitMicrousd: deps.claude.spendLimitMicrousd,
    },
    inFlight,
  );
}

type NotScreenedCode = "not_configured" | "paused" | LlmCapCode | "details_unavailable";

// Without getItem content the alert is made from the summary data, labelled "Not screened by
// Claude: <code>". The code scan sees the title only.
async function alertFromSummary(
  deps: EnrichDeps,
  listing: Listing,
  candidate: KnownCandidate,
  code: NotScreenedCode,
  slot: boolean,
  now: Date,
): Promise<void> {
  const content = listing.content;
  // The content expired before the job ran; an expired message would never be sent. The decision
  // ends the candidate, so relay stops queueing it.
  if (content === null) {
    await setCandidateDecision(deps.pool, candidate.id, { decision: "expired", rejectReason: null });
    deps.log.info({ event: "enrich_done", listing_id: listing.id, decision: "expired", slot, code });
    return;
  }
  const rule = await segmentRule(deps.pool, candidate.segment);
  const codeSignals = scanListing({
    title: content.title,
    descriptionHtml: null,
    shippingOffered: !candidate.flags.includes("pickup_only"),
  });
  const created = await inTransaction(deps.pool, (client) =>
    createAlert(
      deps,
      client,
      { candidate, listing, content, rule, screening: { screened: false, code }, screeningId: null, codeSignals },
      now,
    ),
  );
  if (created === null) return;
  logAlertCreated(deps, created);
  // Only a code scam floor keeps the email back (section 5.7), so blocked follows blockedByCode.
  const decision = created.blockedByCode ? "blocked" : "alerted";
  deps.log.info({ event: "enrich_done", listing_id: listing.id, decision, slot, code });
}

// getItem runs on the alert path: it stops only when 100 units are left (section 3.4).
const ALERT_PATH_MIN_LEFT = 100;

// Cuts to a number of code points, so no surrogate pair is split.
const cut = (text: string, maxChars: number): string => [...text].slice(0, maxChars).join("");

function returnsDays(item: Item): number | null {
  const period = item.returnTerms?.returnPeriod;
  return period !== undefined && period.unit === "DAY" ? period.value : null;
}

// The getItem content as listing_content stores it: the description cleaned and masked as sent to
// Claude, the item specifics cut as sent.
function itemContent(item: Item, fallbackTitle: string, now: Date, itemEndAt: Date | null): ListingContentInput {
  const parsed = toListingCandidate(item, now);
  const seller = parsed.ok ? parsed.listing.seller : { feedbackScore: null, feedbackPercent: null, accountType: null };
  return {
    source: "item",
    title: item.title ?? fallbackTitle,
    condition: item.condition ?? null,
    conditionDescription: item.conditionDescription ?? null,
    sellerFeedbackScore: seller.feedbackScore,
    sellerFeedbackPct: seller.feedbackPercent,
    sellerAccountType: seller.accountType,
    returnsAccepted: item.returnTerms?.returnsAccepted ?? null,
    returnsDays: returnsDays(item),
    itemLocationCountry: item.itemLocation?.country ?? null,
    aspects: (item.localizedAspects ?? []).slice(0, MAX_ITEM_SPECIFICS).map((a) => ({
      name: cut(a.name, MAX_SPECIFIC_NAME_CHARS),
      value: cut(a.value, MAX_SPECIFIC_VALUE_CHARS),
    })),
    descriptionText: item.description === undefined ? null : cleanDescription(item.description).text,
    imageCount: 1 + (item.additionalImages?.length ?? 0),
    fetchedAt: now,
    contentExpiresAt: contentExpiresAt(now, itemEndAt),
  };
}

// shipping_unknown follows what getItem says; the other flags stay as the classifier set them.
function withShippingFlag(flags: readonly ListingFlag[], shippingKnown: boolean): ListingFlag[] {
  const on = new Set<ListingFlag>(flags.filter((f) => f !== "shipping_unknown"));
  if (!shippingKnown) on.add("shipping_unknown");
  return LISTING_FLAGS.filter((f) => on.has(f));
}

// getItem 404 or an ended item: the purge deletes the listing; no alert is made.
async function markGone(deps: EnrichDeps, listingId: string, candidateId: string, reason: GoneReason, now: Date): Promise<void> {
  await inTransaction(deps.pool, async (client) => {
    await markListingGone(client, listingId, reason, now);
    await setCandidateDecision(client, candidateId, { decision: "gone", rejectReason: null });
  });
  deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "gone", slot: true, reason });
}

// The Postgres error code of a failed statement, never its message (it may quote listing text).
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return null;
}

// A rejection after getItem: the content, the getItem prices and the decision in one transaction.
async function rejectAfterEnrich(
  deps: EnrichDeps,
  listingId: string,
  candidateId: string,
  content: ListingContentInput,
  enriched: EnrichedCandidate,
  reason: RejectReason,
): Promise<void> {
  await inTransaction(deps.pool, async (client) => {
    await upsertListingContent(client, listingId, content);
    await updateCandidateAfterEnrich(client, candidateId, enriched);
    await setCandidateDecision(client, candidateId, { decision: "rejected_after_enrich", rejectReason: reason });
  });
  deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "rejected_after_enrich", slot: true, reason });
}

// Everything after a getItem answer: gone or ended, the after-enrich rules, the price band on the
// getItem price and shipping, the code scan of the raw description, then the screen job.
async function afterGetItem(deps: EnrichDeps, listing: Listing, candidate: KnownCandidate, result: GetItemResult, now: Date): Promise<void> {
  const listingId = listing.id;
  if (result.status === "not_found") {
    await markGone(deps, listingId, candidate.id, "not_found", now);
    return;
  }
  const item = result.item;
  const itemEndAt = item.itemEndDate === undefined ? listing.itemEndAt : new Date(item.itemEndDate);
  if (itemEndAt !== null && itemEndAt <= now) {
    await markGone(deps, listingId, candidate.id, "ended", now);
    return;
  }
  if (candidate.priceCents === null) throw new Error("candidate has no price");
  const content = itemContent(item, listing.content?.title ?? "", now, itemEndAt);
  const parsed = toListingCandidate(item, now);
  const priceCents = parsed.ok ? parsed.listing.priceCents : candidate.priceCents;
  const shippingCents = (parsed.ok ? parsed.listing.shippingCents : null) ?? candidate.shippingCents;
  const shippingKnown = shippingCents !== null;
  const landedCents = shippingCents === null ? null : priceCents + shippingCents;
  const flags = withShippingFlag(candidate.flags, shippingKnown);
  // Section 5.6: the scan reads the title and the raw description, before cleanDescription masks
  // IBANs and contact data. The screen job reads the stored signals.
  const codeSignals = scanListing({
    title: content.title,
    descriptionHtml: item.description ?? null,
    shippingOffered: !flags.includes("pickup_only"),
  });
  const enriched: EnrichedCandidate = { priceCents, shippingCents, landedCents, shippingKnown, flags, codeSignals };

  // Section 4: rules 5 to 8, 13 and 14 once more on the getItem fields (RAM 15 to 17 also on the
  // item specifics). A rejection stops here: no Claude call, no alert. The feed comes from the
  // segment, since a listing row v2 wrote may carry a search id where a feed id stood.
  const after = classifyAfterEnrich(
    {
      title: content.title,
      conditionId: item.conditionId ?? null,
      conditionText: content.condition,
      conditionDescription: content.conditionDescription,
      aspects: item.localizedAspects ?? [],
    },
    segmentInfo(candidate.segment).feedId,
    candidate.segment,
  );
  if (after.outcome === "rejected") {
    await rejectAfterEnrich(deps, listingId, candidate.id, content, enriched, after.reason);
    return;
  }
  // Rules 19 and 20 once more with the current rule: a candidate that passed on the item price
  // alone (shipping unknown in the summary), or whose price changed, may now be out of the band.
  const rule = await segmentRule(deps.pool, candidate.segment);
  const band = checkPriceBand(rule, { priceCents, landedCents }, candidate.totalGb ?? after.totalGb);
  if (band !== null) {
    await rejectAfterEnrich(deps, listingId, candidate.id, content, enriched, band);
    return;
  }

  await inTransaction(deps.pool, async (client) => {
    await upsertListingContent(client, listingId, content);
    await updateCandidateAfterEnrich(client, candidate.id, enriched);
    await deps.queue.send("screen", { listingId }, { db: client });
  });
  deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "screen", slot: true });
}

// Section 2.4: one full getItem for a candidate that gets a Claude slot, then the screen job.
export function createEnrichHandler(deps: EnrichDeps): JobHandler<"enrich"> {
  return async ({ listingId }, job) => {
    const now = deps.clock.now();
    const found = await getCandidateByListingId(deps.pool, listingId);
    if (found === null || found.decision !== "pending") return;
    const candidate = await knownCandidate(deps.pool, found);
    if (candidate === null) {
      deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "expired", slot: false, reason: "unknown_segment" });
      return;
    }
    const listing = await getListing(deps.pool, listingId);
    // A gone or deleted listing can never alert; the decision stops relay from queueing it again.
    if (listing === null || listing.goneAt !== null) {
      await setCandidateDecision(deps.pool, candidate.id, { decision: "gone", rejectReason: null });
      deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "gone", slot: false });
      return;
    }
    if (candidate.priceCents === null) throw new Error("candidate has no price");

    // Enrich started before: another job runs it, or it already queued screen (getItem content
    // stored). Started over 10 minutes ago without getItem content, the job died after the flag;
    // relay queued this job, and the deal goes out from the summary without a second getItem.
    if (candidate.enrichStartedAt !== null) {
      const lost = now.getTime() - candidate.enrichStartedAt.getTime() >= RELAY_LOST_AFTER_MS;
      if (lost && listing.content?.source !== "item") {
        await alertFromSummary(deps, listing, candidate, "details_unavailable", true, now);
      }
      return;
    }

    // No Claude slot (no key, paused, or the daily caps leave no room): no getItem; the alert is
    // made from the summary data.
    const slot = await claudeSlot(deps, now);
    if (slot !== "ok") {
      await alertFromSummary(deps, listing, candidate, slot, false, now);
      return;
    }

    // Set before the call, so relay can tell a lost job from a running one; a second job stops here.
    if (!(await markEnrichStarted(deps.pool, candidate.id, now))) return;
    let result: GetItemResult;
    try {
      result = await deps.getItem(
        listing.itemId,
        { endUserContext: endUserContext(deps.postalCode) },
        { callClass: "alert-path", purpose: "enrich", minLeft: ALERT_PATH_MIN_LEFT, signal: job.signal },
      );
    } catch (error) {
      // getItem failed on every attempt (timeout, network, 5xx), or the reservation or the job's
      // deadline stopped it: the deal still goes out, from the summary data.
      if (!(error instanceof EbayError)) throw error;
      await alertFromSummary(deps, listing, candidate, "details_unavailable", true, now);
      return;
    }
    try {
      await afterGetItem(deps, listing, candidate, result, now);
    } catch (error) {
      // Storing the getItem result failed (its transaction rolled back): the deal still goes out,
      // from the summary data. If that fails too, relay finds the candidate after 10 minutes.
      deps.log.warn({ event: "enrich_failed", listing_id: listingId, error_code: errorCode(error) });
      await alertFromSummary(deps, listing, candidate, "details_unavailable", true, now);
    }
  };
}
