# ADR-0031: Deep-evaluation revisions without price

**Date**: 2026-10-19
**Status**: proposed (accept before phase 3 slice 3.7 starts)
**Related**: changes the `deep` row of [ADR 0015](0015-job-execution-idempotency-and-delivery.md) part B; [ADR 0009](0009-configuration-and-decision-versioning.md), [ADR 0018](0018-claude-data-flow-and-residency.md), [ADR 0019](0019-listing-screening-pipeline.md), [ADR 0020](0020-risk-verdict-and-evidence-verification.md), [ADR 0028](0028-screening-budget-and-model-selection.md), [ADR 0032](0032-auction-path.md); [phase 3](../planning/phases/phase-3.md) slices 3.5, 3.7, AC-11; D-01

If ADR 0015 is accepted in the same pull request, this change goes into ADR 0015 part B and this record is marked superseded. If ADR 0015 is accepted first, this record replaces its part B `deep` row and re-evaluation triggers.

## Context

- ADR 0015 part B hashes the `deep` revision over landed price, currency, end time, description hash and image hashes. It starts a new paid deep call when the listing reaches a better tier or its landed price drops by a configured share.
- Under ADR 0018 the deep evaluation never receives the price. It gets the title, the masked description, return terms, seller numbers without identity and up to 8 images. Code handles price anomalies in `decideRisk()` (ADR 0020).
- A price change cannot change what Claude sees, so a new call on a price drop pays for the same findings. A deep call costs an estimated $0.073-0.188 on Sonnet 5.5 and $0.146-0.375 on Opus 5.5 (ADR 0028).
- Every auction bid changes the price. Phase 4 (ADR 0032) needs a revision rule that ignores bids.

## Decision

The `deep` revision hash is `deep-v2:` over the SHA-256 of the NFC-normalised, whitespace-collapsed title, the SHA-256 of the masked description, the SHA-256 of the return terms and the ordered SHA-256 list of the selected image bytes. Price, currency and end time are not inputs. For auctions it also includes `sellerItemRevision`, so a seller edit is a new revision and a bid is not.

A paid deep call runs only when no `done` row exists for (item_key, `deep`, revision_hash, prompt_version), and only within the per-item cap from the decision config (start: 3 deep evaluations per item per 7 days). A better tier or lower price re-runs `decideRisk()` and routing in code on the stored findings. Beyond the cap, a changed revision gets at least CAUTION with reason code `changed_after_screening`.

The rest of ADR 0015 part B stays: claim key, lease, attempt counter as fencing token, takeover, relay, 3-attempt cap. `triage`, `image_confirm` and `triage_shadow` are unchanged; `deep_shadow` uses the new `deep` inputs. Seller numbers stay out of the hash.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep ADR 0015 part B as written | The new call sees the same input; it costs money and queue time for no new information. |
| Include seller numbers in the hash | Feedback counts change with every rating, so calls would repeat; code signals already score seller numbers on every decide. |

## Consequences

**Positive**
- Price-only changes cost no Claude call; phase 3 spend falls with no loss of evidence.
- One rule covers fixed-price listings and auctions.

**Negative**
- A seller who changes only the price on a misleading listing is not re-read by Claude; the stored findings still apply.
- One more record to keep in step with ADR 0015.

**Risks**
- A scam arrives through a description edit after the cap is reached. Mitigation: `changed_after_screening` gives at least CAUTION, and the deterministic full-text scan runs on every fetch (ADR 0020).

## How we check it

- Unit test: the `deep` revision function takes no price, currency or end-time argument (type-level test); changing the title, masked description, return terms or one image changes the hash.
- Integration test with a counting fake evaluator (phase 3 AC-11): a price-only change makes no call and re-runs `decideRisk()`; a changed description makes one call up to the cap; beyond the cap the listing gets `changed_after_screening`.
- The ADR 0015 crash-replay tests pass unchanged against the new hash.

## Revisit when

- The deep evaluation starts to receive the price (a change to ADR 0018).
- Field labels show scams that a re-read on a price drop would have caught.
