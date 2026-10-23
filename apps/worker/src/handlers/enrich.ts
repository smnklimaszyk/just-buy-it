import {
  countScreensInFlight,
  getCandidateByListingId,
  getListing,
  insertAlert,
  insertAlertMessage,
  insertDelivery,
  llmSlotAvailable,
  loadProduct,
  loadSettings,
  markEnrichStarted,
  markListingGone,
  newestOkMarketValues,
  RELAY_LOST_AFTER_MS,
  screeningPausedUntil,
  setCandidateDecision,
  upsertListingContent,
  type DbPool,
  type Candidate,
  type GoneReason,
  type Listing,
  type ListingContentInput,
  type LlmCapCode,
  type Queryable,
  type StoredProduct,
} from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import {
  berlinDay,
  cleanDescription,
  contentExpiresAt,
  finalVerdict,
  inactiveProductReason,
  MATCH_LISTING_FLAGS,
  matchAfterEnrich,
  resolveLimit,
  routeAlert,
  scanListing,
  toListingCandidate,
  type BuyerProfile,
  type Clock,
  type CodeSignal,
  type ConditionGroup,
  type LimitResolution,
  type MatchReason,
  type Settings,
  type SettingsEnv,
  type Verdict,
} from "@ebay-sniper/domain";
import { EbayError, endUserContext, type BrowseCallContext, type GetItemRequest, type GetItemResult, type Item } from "@ebay-sniper/ebay";
import {
  MAX_ITEM_SPECIFICS,
  MAX_SPECIFIC_NAME_CHARS,
  MAX_SPECIFIC_VALUE_CHARS,
  PROMPT_VERSION,
  screeningChoice,
  worstCaseCostMicrousd,
  type ClaudeScreener,
  type ScreeningChoice,
} from "@ebay-sniper/llm";
import { renderAlertEmail, type AlertLimit, type AlertScreening } from "@ebay-sniper/notify";
import { conditionGroups, inTransaction, type LogFn } from "./poll.js";

export type GetItemFn = (itemId: string, request: GetItemRequest, call: BrowseCallContext) => Promise<GetItemResult>;

// Screening is configured when there is a screener (ANTHROPIC_API_KEY set). The caps come from the
// settings, read per job (spec 4.4); callLimit and spendLimitMicrousd are the .env values.
export type ClaudeSettings = {
  screener: ClaudeScreener | null;
  callLimit: number;
  spendLimitMicrousd: number;
};

// What the enrich and screen jobs need to make an alert. The buyer profile of an alert is the
// product's (spec 2.1); alerts.recipient is ALERT_TO.
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
  // The .env bounds of the settings (spec 2.5).
  settingsEnv: SettingsEnv;
};

export type AlertSource = {
  candidate: Candidate;
  product: StoredProduct;
  listing: Listing;
  // getItem content, or the summary content for an alert made without getItem.
  content: ListingContentInput;
  screening: AlertScreening;
  screeningId: string | null;
  codeSignals: CodeSignal[];
};

// What createAlert did. A repeat (a second or retried job) gets null.
export type AlertOutcome =
  | { kind: "alert"; alertId: string; finalVerdict: Verdict; blockedByCode: boolean }
  // Spec 4.3: Claude says this is not the product. Never emailed; the item key leaves the
  // product's market pool.
  | { kind: "wrong_product"; candidateId: string }
  // Spec 4.3: the product only alerts after a Claude check, and the check did not happen.
  | { kind: "held"; candidateId: string; heldReason: string };

// v2 decisions, written once from pending. Reject reasons are the matcher's (spec 3.4).
type CandidateEnd =
  | { decision: "rejected_after_enrich"; reason: MatchReason }
  | { decision: "wrong_product" }
  | { decision: "held"; heldReason: string };

async function endCandidate(db: Queryable, candidateId: string, end: CandidateEnd): Promise<boolean> {
  const result = await db.query(
    `UPDATE app.candidate SET decision = $2, reject_reason = $3, held_reason = $4
      WHERE id = $1 AND decision = 'pending'`,
    [
      candidateId,
      end.decision,
      end.decision === "rejected_after_enrich" ? end.reason : null,
      end.decision === "held" ? end.heldReason : null,
    ],
  );
  return result.rowCount === 1;
}

// The candidate's product as it is now, or why the candidate ends: a key with no product (a
// segment never imported) ends like an unknown one.
export async function candidateProduct(
  db: Queryable,
  candidate: Candidate,
): Promise<{ product: StoredProduct } | { ended: "unknown_segment" | "product_paused" | "product_archived" }> {
  const product = await loadProduct(db, candidate.segment);
  if (product === null) return { ended: "unknown_segment" };
  // Spec 9: a product that is not active makes no getItem, no Claude call and no alert. A draft
  // too: Release 0 candidates still pending when the import writes the drafts end here (spec 11.5).
  const ended = inactiveProductReason(product.rules.status);
  return ended === null ? { product } : { ended };
}

// Spec 6.4: the limit of each watched condition group for a listing first seen at `at`, from the
// product as it is now. Per GB when the product prices per GB. The values before `at` and before
// `now`, so resolveLimit can fall back the way the poll does when none came before `at`.
async function currentLimits(
  db: Queryable,
  product: StoredProduct,
  at: Date,
  now: Date,
): Promise<Map<ConditionGroup, LimitResolution>> {
  const values =
    product.rules.priceMode === "below_market"
      ? [
          ...(await newestOkMarketValues(db, product.id, product.matchVersion, at)),
          ...(await newestOkMarketValues(db, product.id, product.matchVersion, now)),
        ]
      : [];
  const limitProduct = { ...product.rules, matchVersion: product.matchVersion };
  return new Map(conditionGroups(product).map((group) => [group, resolveLimit(limitProduct, group, values, at, now)] as const));
}

// The limit the email shows: the same resolution Claude gets (spec 6.4). A candidate without a
// condition group (written before v2) is measured against the cap.
async function alertLimit(db: Queryable, product: StoredProduct, candidate: Candidate, listing: Listing, now: Date): Promise<AlertLimit> {
  const group = candidate.conditionGroup;
  const limit = group === null ? undefined : (await currentLimits(db, product, listing.firstSeenAt, now)).get(group);
  if (limit === undefined) return { limitCents: product.rules.maxCents, priceMode: product.rules.priceMode, marketValueCents: null };
  return { limitCents: limit.limitCents, priceMode: limit.priceMode, marketValueCents: limit.marketValue?.valueCents ?? null };
}

// Section 6.1, inside the screen or enrich result transaction. Claude's mismatch ends the
// candidate wrong_product; a product that requires the Claude check holds a candidate Claude
// could not check (spec 4.3). Otherwise the alert, and unless a code scam floor fired, one
// delivery for ALERT_TO with its rendered message and the send job. Who else gets it in Bcc is
// read when it is sent.
export async function createAlert(
  deps: AlertDeps,
  client: Queryable,
  source: AlertSource,
  now: Date,
): Promise<AlertOutcome | null> {
  const { candidate, product, screening } = source;
  if (candidate.priceCents === null) throw new Error("candidate has no price");
  const verdict = finalVerdict(screening, source.codeSignals);
  if (verdict.productMatch === "mismatch") {
    const ended = await endCandidate(client, candidate.id, { decision: "wrong_product" });
    return ended ? { kind: "wrong_product", candidateId: candidate.id } : null;
  }
  if (!screening.screened && product.rules.claudeRequired) {
    const ended = await endCandidate(client, candidate.id, { decision: "held", heldReason: screening.code });
    return ended ? { kind: "held", candidateId: candidate.id, heldReason: screening.code } : null;
  }
  const buyerProfile = product.rules.buyerProfile;
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
    buyerProfile,
    createdAt: now,
  });
  // A repeat (a second or retried job) finds the alert and makes nothing more.
  if (!alert.created) return null;
  // Section 5.7: a code-verified scam floor keeps the alert on the dashboard only.
  const route = routeAlert(verdict);
  await setCandidateDecision(client, candidate.id, { decision: route.sendEmail ? "alerted" : "blocked", rejectReason: null });
  const created: AlertOutcome = {
    kind: "alert",
    alertId: alert.id,
    finalVerdict: verdict.finalVerdict,
    blockedByCode: verdict.blockedByCode,
  };
  if (!route.sendEmail) return created;
  const deliveryId = await insertDelivery(client, { alertId: alert.id, recipient: deps.alerts.recipient, now });
  const { listing, content } = source;
  const email = renderAlertEmail({
    deliveryId,
    product: { name: product.rules.name, perGb: product.rules.perGb },
    limit: await alertLimit(client, product, candidate, listing, now),
    buyerProfile,
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
    screening,
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

// Logged after the commit, so the line never names an alert or a decision that was rolled back.
export function logAlertCreated(deps: AlertDeps, outcome: AlertOutcome): void {
  if (outcome.kind === "alert") {
    deps.log.info({
      event: "alert_created",
      alert_id: outcome.alertId,
      final_verdict: outcome.finalVerdict,
      blocked_by_code: outcome.blockedByCode,
    });
    return;
  }
  if (outcome.kind === "held") {
    deps.log.info({ event: "candidate_held", candidate_id: outcome.candidateId, held_reason: outcome.heldReason });
    return;
  }
  deps.log.info({ event: "candidate_wrong_product", candidate_id: outcome.candidateId });
}

// The decision an outcome leaves on the candidate, for the enrich_done line.
function decisionOf(outcome: AlertOutcome): string {
  if (outcome.kind === "alert") return outcome.blockedByCode ? "blocked" : "alerted";
  return outcome.kind;
}

// Read-only (section 2.4): configured, not paused, and the day leaves room for one worst-case call
// of the model screen will use under both caps of the settings, after the candidates already past
// getItem that wait for their screen, with the product within its share (spec 4.4). The screen job
// makes the reservation. This keeps getItem within the Claude call cap (section 3.4).
async function claudeSlot(
  deps: EnrichDeps,
  settings: Settings,
  choice: ScreeningChoice,
  productKey: string,
  now: Date,
): Promise<"ok" | "not_configured" | "paused" | LlmCapCode> {
  if (deps.claude.screener === null) return "not_configured";
  if ((await screeningPausedUntil(deps.pool, now)) !== null) return "paused";
  const inFlight = await countScreensInFlight(deps.pool, PROMPT_VERSION);
  return llmSlotAvailable(
    deps.pool,
    {
      day: berlinDay(now),
      worstMicrousd: worstCaseCostMicrousd(choice.model),
      callLimit: settings.claudeDailyCallLimit,
      spendLimitMicrousd: settings.claudeDailySpendLimitMicrousd,
      productKey,
    },
    inFlight,
  );
}

type NotScreenedCode = "not_configured" | "paused" | LlmCapCode | "details_unavailable";

// Without getItem content the alert is made from the summary data, labelled "Not checked by
// Claude: <code>", or held when the product requires the check. The code scan sees the title only.
async function alertFromSummary(
  deps: EnrichDeps,
  listing: Listing,
  candidate: Candidate,
  product: StoredProduct,
  code: NotScreenedCode,
  slot: boolean,
  now: Date,
): Promise<void> {
  const content = listing.content;
  // The content expired before the job ran; an expired message would never be sent. The decision
  // ends the candidate, so relay stops queueing it.
  if (content === null) {
    await setCandidateDecision(deps.pool, candidate.id, { decision: "expired", rejectReason: null });
    deps.log.info({ event: "enrich_done", listing_id: listing.id, decision: "expired", slot, outcome_code: code });
    return;
  }
  const codeSignals = scanListing({
    title: content.title,
    descriptionHtml: null,
    shippingOffered: !candidate.flags.includes("pickup_only"),
  });
  const outcome = await inTransaction(deps.pool, (client) =>
    createAlert(
      deps,
      client,
      { candidate, product, listing, content, screening: { screened: false, code }, screeningId: null, codeSignals },
      now,
    ),
  );
  if (outcome === null) return;
  logAlertCreated(deps, outcome);
  // Not "code": packages/logging redacts a field of that name.
  deps.log.info({ event: "enrich_done", listing_id: listing.id, decision: decisionOf(outcome), slot, outcome_code: code });
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

// shipping_unknown follows what getItem says; the other flags stay as the matcher set them, in its
// order (spec 3.3), the warn flags last.
function withShippingFlag(flags: readonly string[], shippingKnown: boolean): string[] {
  const on = new Set(flags.filter((f) => f !== "shipping_unknown"));
  if (!shippingKnown) on.add("shipping_unknown");
  const listed: readonly string[] = MATCH_LISTING_FLAGS;
  return [...MATCH_LISTING_FLAGS.filter((f) => on.has(f)), ...[...on].filter((f) => !listed.includes(f))];
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

type Enriched = {
  priceCents: number;
  shippingCents: number | null;
  landedCents: number | null;
  shippingKnown: boolean;
  flags: string[];
  codeSignals: CodeSignal[];
};

// getItem's price and shipping may change the price, make the shipping known (or keep it unknown)
// and add flags; the code scan of the raw description adds its signals.
async function storeEnriched(db: Queryable, candidateId: string, enriched: Enriched): Promise<void> {
  await db.query(
    `UPDATE app.candidate SET price_cents = $2, shipping_cents = $3, landed_cents = $4, shipping_known = $5, flags = $6,
            code_signals = $7
      WHERE id = $1 AND decision = 'pending'`,
    [
      candidateId,
      enriched.priceCents,
      enriched.shippingCents,
      enriched.landedCents,
      enriched.shippingKnown,
      enriched.flags,
      enriched.codeSignals,
    ],
  );
}

type HandOff = {
  product: StoredProduct;
  conditionGroup: ConditionGroup;
  unitTotal: number | null;
  limit: LimitResolution;
  choice: ScreeningChoice;
};

// Spec 4.5 and 9, at the hand-off to screen: what the candidate passed after getItem (the product
// version, the condition group of the getItem condition and its limit now) and the prompt version,
// model and effort screen and its retry use, so a settings change between them opens no second
// claim.
async function storeHandOff(db: Queryable, candidateId: string, handOff: HandOff): Promise<void> {
  const { product, limit, choice } = handOff;
  await db.query(
    `UPDATE app.candidate
        SET product_version = $2, match_version = $3, condition_group = $4, limit_cents = $5, price_mode = $6,
            market_value_id = $7, total_gb = coalesce($8, total_gb), prompt_version = $9, model = $10, effort = $11
      WHERE id = $1 AND decision = 'pending'`,
    [
      candidateId,
      product.version,
      product.matchVersion,
      handOff.conditionGroup,
      limit.limitCents,
      limit.priceMode,
      limit.marketValue?.id ?? null,
      handOff.unitTotal,
      choice.promptVersion,
      choice.model,
      choice.effort,
    ],
  );
}

// A rejection after getItem: the content, the getItem prices and the decision in one transaction.
async function rejectAfterEnrich(
  deps: EnrichDeps,
  listingId: string,
  candidateId: string,
  content: ListingContentInput,
  enriched: Enriched,
  reason: MatchReason,
): Promise<void> {
  await inTransaction(deps.pool, async (client) => {
    await upsertListingContent(client, listingId, content);
    await storeEnriched(client, candidateId, enriched);
    await endCandidate(client, candidateId, { decision: "rejected_after_enrich", reason });
  });
  deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "rejected_after_enrich", slot: true, reason });
}

type Run = { listing: Listing; candidate: Candidate; product: StoredProduct; choice: ScreeningChoice; now: Date };

// Everything after a getItem answer: gone or ended, the product's rules and the band on its limit
// now (spec 3.4 matchAfterEnrich, 9), the code scan of the raw description, then the screen job.
async function afterGetItem(deps: EnrichDeps, run: Run, result: GetItemResult): Promise<void> {
  const { listing, candidate, product, now } = run;
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
  const enriched: Enriched = { priceCents, shippingCents, landedCents, shippingKnown, flags, codeSignals };

  // The limit of a listing is resolved at its first sighting, so a cheap listing cannot pull its
  // own reference down (spec 6.4). A rejection stops here: no Claude call, no alert.
  const limits = await currentLimits(deps.pool, product, listing.firstSeenAt, now);
  const after = matchAfterEnrich(
    {
      title: content.title,
      conditionId: item.conditionId ?? null,
      conditionText: content.condition,
      conditionDescription: content.conditionDescription,
      aspects: item.localizedAspects ?? [],
      priceCents,
      landedCents,
    },
    { key: product.key, ...product.rules, limits: Object.fromEntries(limits) },
  );
  if (after.outcome === "rejected") {
    await rejectAfterEnrich(deps, listingId, candidate.id, content, enriched, after.reason);
    return;
  }
  const limit = limits.get(after.conditionGroup);
  if (limit === undefined) throw new Error(`no limit for condition group ${after.conditionGroup}`);

  await inTransaction(deps.pool, async (client) => {
    await upsertListingContent(client, listingId, content);
    await storeEnriched(client, candidate.id, enriched);
    await storeHandOff(client, candidate.id, {
      product,
      conditionGroup: after.conditionGroup,
      unitTotal: after.unitTotal,
      limit,
      choice: run.choice,
    });
    await deps.queue.send("screen", { listingId }, { db: client });
  });
  deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "screen", slot: true });
}

// Section 2.4: one full getItem for a candidate that gets a Claude slot, then the screen job.
export function createEnrichHandler(deps: EnrichDeps): JobHandler<"enrich"> {
  return async ({ listingId }, job) => {
    const now = deps.clock.now();
    const candidate = await getCandidateByListingId(deps.pool, listingId);
    if (candidate === null || candidate.decision !== "pending") return;
    const found = await candidateProduct(deps.pool, candidate);
    if ("ended" in found) {
      await setCandidateDecision(deps.pool, candidate.id, { decision: "expired", rejectReason: found.ended });
      deps.log.info({ event: "enrich_done", listing_id: listingId, decision: "expired", slot: false, reason: found.ended });
      return;
    }
    const { product } = found;
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
        await alertFromSummary(deps, listing, candidate, product, "details_unavailable", true, now);
      }
      return;
    }

    // The settings as they are now: the model and effort screen will use, and both caps.
    const { settings } = await loadSettings(deps.pool, deps.settingsEnv);
    const choice = screeningChoice({ promptVersion: null, model: null, effort: null }, settings);
    // No Claude slot (no key, paused, or the daily caps leave no room): no getItem; the alert is
    // made from the summary data.
    const slot = await claudeSlot(deps, settings, choice, product.key, now);
    if (slot !== "ok") {
      await alertFromSummary(deps, listing, candidate, product, slot, false, now);
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
      await alertFromSummary(deps, listing, candidate, product, "details_unavailable", true, now);
      return;
    }
    try {
      await afterGetItem(deps, { listing, candidate, product, choice, now }, result);
    } catch (error) {
      // Storing the getItem result failed (its transaction rolled back): the deal still goes out,
      // from the summary data. If that fails too, relay finds the candidate after 10 minutes.
      deps.log.warn({ event: "enrich_failed", listing_id: listingId, error_code: errorCode(error) });
      await alertFromSummary(deps, listing, candidate, product, "details_unavailable", true, now);
    }
  };
}
