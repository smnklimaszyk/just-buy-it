import { setTimeout } from "node:timers/promises";
import {
  claimScreening,
  finishScreening,
  getCandidateByListingId,
  getListing,
  getScreening,
  MAX_SCREEN_ATTEMPTS,
  pauseScreening,
  releaseScreeningLease,
  reserveLlmCall,
  screeningPausedUntil,
  settleLlmCall,
  type ScreeningUsage,
} from "@ebay-sniper/db";
import type { JobHandler } from "@ebay-sniper/db/queue";
import { berlinDay, type SegmentRule } from "@ebay-sniper/domain";
import {
  buildScreeningRequest,
  ClaudeError,
  MODEL,
  PROMPT_VERSION,
  RETRY_DELAY_SECONDS,
  retryDelaySeconds,
  WORST_CASE_COST_MICROUSD,
  type ScreeningResult,
} from "@ebay-sniper/llm";
import type { AlertScreening } from "@ebay-sniper/notify";
import {
  createAlert,
  knownCandidate,
  logAlertCreated,
  segmentRule,
  type AlertDeps,
  type AlertSource,
  type ClaudeSettings,
} from "./enrich.js";
import { inTransaction } from "./poll.js";

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type ScreenDeps = AlertDeps & {
  claude: ClaudeSettings;
  // Tests pass a fake; the worker uses the timer.
  sleep?: Sleep;
};

const sleepFor: Sleep = (ms, signal) => setTimeout(ms, undefined, { signal });

// ADR 0019: auth_failed pauses screening for all listings.
const SCREENING_PAUSE_MS = 15 * 60_000;

// The owner's maximum landed price for this item: the per-item max, or per-GB max x total GB
// (the classifier gives every per-GB candidate its total).
function ownerMaxCents(rule: SegmentRule, totalGb: number | null): number {
  if (rule.kind === "per_item") return rule.maxLandedCents;
  if (totalGb === null) throw new Error("a per-GB candidate has no total GB");
  return rule.maxCentsPerGb * totalGb;
}

type AlertBase = Omit<AlertSource, "screening" | "screeningId">;

type NotScreened = { status: "failed" | "skipped"; code: string; usage: ScreeningUsage | null };

// A failed or skipped screening, written fenced on the attempt, and the alert labelled "Not
// screened by Claude: <code>", in one transaction.
async function finishNotScreened(
  deps: ScreenDeps,
  claim: { id: string; attempt: number },
  base: AlertBase,
  outcome: NotScreened,
  now: Date,
): Promise<void> {
  const created = await inTransaction(deps.pool, async (client) => {
    // Fenced on the attempt: a late failure after another attempt took over is dropped.
    const written = await finishScreening(client, {
      id: claim.id,
      attempt: claim.attempt,
      now,
      status: outcome.status,
      verdict: null,
      productMatch: null,
      riskFlags: [],
      codeSignals: base.codeSignals,
      failureCode: outcome.code,
      reason: null,
      reasonExpiresAt: null,
      usage: outcome.usage,
    });
    if (!written) return null;
    return createAlert(deps, client, { ...base, screening: { screened: false, code: outcome.code }, screeningId: claim.id }, now);
  });
  if (created !== null) logAlertCreated(deps, created);
  const usage = outcome.usage;
  deps.log.info({
    event: "screening_done",
    screening_id: claim.id,
    status: outcome.status,
    verdict: null,
    failure_code: outcome.code,
    request_bytes: usage?.requestBytes ?? null,
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    cost_microusd: usage?.costMicrousd ?? null,
    latency_ms: usage?.latencyMs ?? null,
  });
}

// Section 2.4: one Claude call per claim, the result written fenced on the attempt.
export function createScreenHandler(deps: ScreenDeps): JobHandler<"screen"> {
  return async ({ listingId }, job) => {
    const now = deps.clock.now();
    const screener = deps.claude.screener;
    const listing = await getListing(deps.pool, listingId);
    const found = await getCandidateByListingId(deps.pool, listingId);
    // A candidate with its decision made (alerted, rejected, gone) is not screened again.
    if (listing === null || found === null || found.decision !== "pending") return;
    const candidate = await knownCandidate(deps.pool, found);
    if (candidate === null) {
      deps.log.info({ event: "screen_done", listing_id: listingId, decision: "expired", reason: "unknown_segment" });
      return;
    }
    if (candidate.priceCents === null) return;
    // Only getItem content (enrich done) of a listing that is not gone reaches Claude.
    if (listing.goneAt !== null) return;
    const content = listing.content;
    if (content === null || content.source !== "item") return;

    // Section 5.6 code signals, which enrich took from the title and the raw description before
    // the masking. They go to Claude and set the floors of the final verdict.
    const codeSignals = candidate.codeSignals;
    const rule = await segmentRule(deps.pool, candidate.segment);
    const base: AlertBase = { candidate, listing, content, rule, codeSignals };

    const claim = await claimScreening(deps.pool, { itemKey: candidate.itemKey, promptVersion: PROMPT_VERSION, model: MODEL, now });
    // Attempt 2 lost its lease (a crash): the claim wrote failed with attempts_exhausted, and the
    // alert goes out as not screened.
    if (claim.kind === "exhausted") {
      const created = await inTransaction(deps.pool, (client) =>
        createAlert(deps, client, { ...base, screening: { screened: false, code: "attempts_exhausted" }, screeningId: claim.id }, now),
      );
      if (created !== null) logAlertCreated(deps, created);
      return;
    }
    // A finished screening is reused without a call; the alert insert is idempotent, so a repeat
    // makes nothing more.
    if (claim.kind === "finished") {
      const stored = await getScreening(deps.pool, claim.id);
      if (stored === null) return;
      const screening: AlertScreening =
        stored.status === "done" && stored.verdict !== null && stored.productMatch !== null
          ? {
              screened: true,
              verdict: stored.verdict,
              productMatch: stored.productMatch,
              riskFlags: stored.riskFlags,
              reason: stored.reason ?? "",
            }
          : { screened: false, code: stored.failureCode ?? stored.status };
      const created = await inTransaction(deps.pool, (client) =>
        createAlert(deps, client, { ...base, codeSignals: stored.codeSignals, screening, screeningId: claim.id }, now),
      );
      if (created !== null) logAlertCreated(deps, created);
      return;
    }
    if (claim.kind !== "claimed") return;

    // No key (removed after enrich): skipped.
    if (screener === null) {
      await finishNotScreened(deps, claim, base, { status: "skipped", code: "not_configured", usage: null }, now);
      return;
    }
    // After auth_failed every listing skips with paused, without a reservation.
    if ((await screeningPausedUntil(deps.pool, now)) !== null) {
      await finishNotScreened(deps, claim, base, { status: "skipped", code: "paused", usage: null }, now);
      return;
    }
    const request = buildScreeningRequest(
      {
        segment: candidate.segment,
        title: content.title,
        condition: content.condition,
        conditionDescription: content.conditionDescription,
        priceCents: candidate.priceCents,
        shippingCents: candidate.shippingCents,
        ownerMaxCents: ownerMaxCents(rule, candidate.totalGb),
        seller: {
          feedbackScore: content.sellerFeedbackScore,
          feedbackPercent: content.sellerFeedbackPct,
          accountType: content.sellerAccountType,
        },
        returns: { accepted: content.returnsAccepted, periodDays: content.returnsDays },
        itemLocationCountry: content.itemLocationCountry,
        itemCreationAt: listing.itemCreationAt,
        itemSpecifics: content.aspects ?? [],
        imageCount: content.imageCount ?? 1,
        descriptionText: content.descriptionText,
        ruleFlags: candidate.flags,
        codeSignals,
      },
      now,
    );
    // Section 5.5: both daily caps in one reservation before the call; the actual cost settles it.
    const day = berlinDay(now);
    const worst = WORST_CASE_COST_MICROUSD;
    const reservation = await reserveLlmCall(deps.pool, {
      day,
      worstMicrousd: worst,
      callLimit: deps.claude.callLimit,
      spendLimitMicrousd: deps.claude.spendLimitMicrousd,
    });
    // A refused reservation makes no call.
    if (!reservation.ok) {
      await finishNotScreened(deps, claim, base, { status: "skipped", code: reservation.code, usage: null }, now);
      return;
    }
    const callStart = deps.clock.now().getTime();
    let result: ScreeningResult;
    try {
      result = await screener.screen(request.userMessage, job.signal);
    } catch (error) {
      if (!(error instanceof ClaudeError)) throw error;
      // Every call that reached Anthropic stores its usage and cost, failures included. Without
      // usage the worst case is settled: the request may have been billed.
      const latency = deps.clock.now().getTime() - callStart;
      const actual = error.costMicroUsd ?? worst;
      await settleLlmCall(deps.pool, { day, worstMicrousd: worst, actualMicrousd: actual });
      const usage: ScreeningUsage = {
        requestBytes: request.requestBytes,
        inputTokens: error.usage?.inputTokens ?? null,
        outputTokens: error.usage?.outputTokens ?? null,
        costMicrousd: error.costMicroUsd,
        reservedMicrousd: worst,
        latencyMs: latency,
        inferenceGeo: null,
      };
      // auth_failed pauses screening for every listing for 15 minutes.
      if (error.code === "auth_failed") {
        const until = new Date(now.getTime() + SCREENING_PAUSE_MS);
        await pauseScreening(deps.pool, until);
        deps.log.warn({ event: "screening_paused", until: until.toISOString(), failure_code: error.code });
      }
      // A retryable failure on attempt 1 releases the lease at once and throws, so the pg-boss retry
      // 30 s later takes over as attempt 2 instead of waiting for the lease.
      if (error.retryable && claim.attempt < MAX_SCREEN_ATTEMPTS) {
        // A retry-after above the queue's 30 s retry delay (at most 60 s) is waited out here, so
        // the retry runs no earlier than Anthropic asked.
        const extraMs = (retryDelaySeconds(error) - RETRY_DELAY_SECONDS) * 1000;
        if (extraMs > 0) await (deps.sleep ?? sleepFor)(extraMs, job.signal);
        await releaseScreeningLease(deps.pool, { id: claim.id, attempt: claim.attempt, failureCode: error.code, now, usage });
        throw error;
      }
      await finishNotScreened(deps, claim, base, { status: "failed", code: error.code, usage }, now);
      return;
    }
    const latencyMs = deps.clock.now().getTime() - callStart;
    await settleLlmCall(deps.pool, { day, worstMicrousd: worst, actualMicrousd: result.costMicroUsd });
    // The result, the alert and the send job in one transaction.
    const created = await inTransaction(deps.pool, async (client) => {
      // Fenced on the attempt: when another attempt took the claim over, this late result is
      // dropped and makes no alert.
      const written = await finishScreening(client, {
        id: claim.id,
        attempt: claim.attempt,
        now,
        status: "done",
        verdict: result.answer.verdict,
        productMatch: result.answer.productMatch,
        riskFlags: result.answer.riskFlags,
        codeSignals,
        failureCode: null,
        reason: result.answer.reason,
        reasonExpiresAt: content.contentExpiresAt,
        usage: {
          requestBytes: request.requestBytes,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costMicrousd: result.costMicroUsd,
          reservedMicrousd: worst,
          latencyMs,
          inferenceGeo: result.inferenceGeo,
        },
      });
      if (!written) return null;
      return createAlert(
        deps,
        client,
        {
          ...base,
          screening: {
            screened: true,
            verdict: result.answer.verdict,
            productMatch: result.answer.productMatch,
            riskFlags: result.answer.riskFlags,
            reason: result.answer.reason,
          },
          screeningId: claim.id,
        },
        now,
      );
    });
    if (created !== null) logAlertCreated(deps, created);
    deps.log.info({
      event: "screening_done",
      screening_id: claim.id,
      status: "done",
      verdict: result.answer.verdict,
      failure_code: null,
      request_bytes: request.requestBytes,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cost_microusd: result.costMicroUsd,
      latency_ms: latencyMs,
    });
  };
}
