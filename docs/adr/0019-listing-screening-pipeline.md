# ADR-0019: Listing screening stages, per-listing failures and degraded mode

**Date**: 2026-10-19
**Status**: proposed (waits on D-31)
**Related**: ADR 0006, 0008, 0009, 0014, 0015, 0018, 0020, 0024, 0028; D-31, D-48

## Context

- Seller text and photos are untrusted; if refusals counted as outages, a seller could trigger one to skip the fraud gate.
- A refusal is HTTP 200 with `stop_reason: "refusal"`; `max_tokens` output may break the schema; length limits are not enforced; enum case can vary; Haiku 5.5 has no server-side fallback ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [refusals](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)).
- Errors that hit every request: 401-403, 429 (spend-cap 429 has no `retry-after`), 500/504/529, 400 on a spend limit ([errors](https://platform.claude.com/docs/en/api/errors)). Effort and thinking differ by model and platform.
- ADR 0014 purges content after 6 hours; pg-boss leaves equal-priority order undefined.

## Decision

Tool-less calls in three stages, a strict schema checked by Zod 4. Listing-caused failures stay on the listing; global causes open a circuit breaker (degraded mode); no other model ever answers in place of the configured one.

| Item | Rule |
|---|---|
| Triage | Haiku 5.5, `low` effort, thinking off; summary title, specifics, price; rejects only clear junk. Failure goes to deep as `triage_failed` |
| Deep input | Title, masked description (3,000 head + 1,000 tail tokens), return terms, seller numbers without identity, first 8 images full size; `max_tokens` 16,000. Row records `images_total`, `images_sent`, `description_truncated` |
| Schema | All required: `product_match`, `coverage`, `findings` (code, family, severity, `evidence_type`, quote or image index, `explanation`); no reasoning field. Lower-case snake_case enums, lower-cased by Zod first; max 12 findings, 300-char quotes; over-limit is `schema_invalid` |
| Codes | Per listing: `refused`, `truncated`, `schema_invalid`, `timeout`, `request_rejected` (400/413), `unexpected_model`. Global: `provider_unavailable`, `auth_failed`, `rate_limited`. Domain never sees `stop_reason`, `stop_details` or HTTP status; refusal category is an opaque `provider_detail`. ADR 0009 config holds only an `evaluator_config_id` per stage; provider fields live in `packages/llm/src/evaluator-configs/<id>.ts`, hashed into `prompt_version` |
| Per-listing failure | CAUTION, digest "screening failed: <code>", review queue. One retry per claim key (item, stage, revision, `prompt_version`), only for `schema_invalid`, `truncated` (2x `max_tokens`), `timeout` (deep 120 s, triage 30 s, confirm 60 s). Row stores `last_failure_code`; a 2nd listing-caused failure sets `failed` in the same transaction (max 2 paid listing-caused attempts). ADR 0015's cap of 3 also counts crashes and global errors. `image_confirm` failure: finding unverified (CAUTION), no retry |
| Breaker | Shared by all `screen.*` queues. Opens on 3 consecutive unavailable/timeouts on different listings in 10 min (probe 5 min); `auth_failed` (probe 15 min); 429 without `retry-after` or 3 in a row (with it, the job waits); 2nd `request_rejected` on another listing in 10 min; budget spent (ADR 0028); kill switch. Then ops email, no claims, digest "not reviewed by Claude". A timeout while open is degraded. Global errors set no `last_failure_code`; cap reached after one is `failed` with `provider_unavailable`, degraded. On close, in-window listings run in priority order |
| No fallback | No `fallbacks` field or `server-side-fallback-*` header |
| Queues | Concurrency 1; priority No-brainer, Good, Unrated under maximum, Fair, then discount. Max 10 deep per feed per hour; No-brainers exempt but counted; over 10 No-brainers per feed per hour sends an ops email. Breaker closed with lane budget: a No-brainer waits at most for one in-flight deep call. Lane spent: all go to the degraded digest |
| Expiry | Content expires before stage timeout: no call, `not_screened_expired`, digest entry (segment, landed price, tier, link, no listing text), skipped if already in the degraded digest. Ops email if a No-brainer or Good expires, over 5 expire a day, or oldest deep job passes 2 hours |

## Alternatives considered

- Deep evaluation for all: $99-254 a month against $10-25 with triage.
- Web search: tools plus untrusted input risk exfiltration.
- Refusals as outage, or every 400 per listing: a seller skips screening; a broken schema fails all listings silently.
- Instant unreviewed emails when degraded: an outage is when a scam passes.
- getItem refresh of expired content: spends eBay calls in the flood.
- Model settings in domain config: Bedrock would need domain changes.
- Server-side fallbacks: answering model never evaluated; beta.
- Batch API: asynchronous; ADR 0018 keeps eBay content out of it.
- Images at 1,024 px: saves $3-6 a month, hides serial stickers.

## Consequences

**Positive**: sellers cannot reach the unreviewed path; global faults stop screening with an ops email; one visible end state per listing; Bedrock needs only new config files.

**Negative**: more codes and labels; two different transient problems fail a listing; the first 400 of a bad shape is mislabelled; descriptions lose their middle; images after the 8th unseen; lower tiers can expire in a flood.

**Risks**: refusal floods (ops email above 3 per feed per day); revoked key over a weekend (runbook ADR 0011); eBay revokes the keyset.

## How we check it

- Property: per-listing codes give at least CAUTION, no instant channel, at most one retry and 2 listing-caused attempts.
- Breaker, injected clock (ADR 0008), incl. 429 with and without `retry-after`; no claim while open.
- Postgres: expired job makes no call and emails ops; a 2-hour wait sends the queue-age email.
- Adapter fixtures: each refusal and error code, `"Critical"` enum, 13 findings, other `model`.
- Request builder: no `tools`, `fallbacks` or fallback header; a config change changes `prompt_version`.
- ADR 0009 schema test: every evaluation row has model, effort, prompt, schema, rubric versions.
- Manual contract job sends the real schema once per run.
- Lint: no `@anthropic-ai/sdk`, `stop_reason`, `stop_details`, `thinking` in domain evaluator types; no `fallbacks` in `packages/llm`.
- Ops page: failures by code, refusals per feed, breaker openings, degraded minutes, `screening_expired`, oldest deep job.

## Revisit when

- Refusals high for a week, or over 2% of keys fail twice.
- A No-brainer or Good expires twice a month; degraded over 2 hours a week.
- A 9th or later image would have shown a missed scam.
- Anthropic changes error codes, or a second provider is added.
