# ADR-0033: Calibration and configuration change process

**Date**: 2026-10-19
**Status**: proposed (waits on D-08 precision target and minimum alert count, D-50 labels, D-54 approver; accepted before the first calibration round in phase 5 slice 5A.3)
**Related**: ADR 0004, 0009, 0014, 0015, 0016, 0017, 0024, 0026; D-01, D-04, D-08, D-11, D-28, D-37, D-50, D-54; [phase 5](../planning/phases/phase-5.md), [company vs private](../planning/guides/company-vs-private.md)

## Context

- Price-bearing columns on `decision` and `fair_value` are set to NULL 30 days after write (ADR 0014, kept as good practice), so a backtest can replay only about 28 days.
- Rejected candidates are not stored (D-28), so a backtest can only tighten.
- At 1 to 3 alerts a day, four weeks give 30 to 90 labelled alerts. 24 of 30 has a 95% Wilson interval of 0.63 to 0.91, so a backtest cannot separate settings a few points apart.
- The feedback labels cannot tell a deal nobody needed from a price that was not good (D-50).
- Simon (D-01) gives every label and approves every change; there is no second reviewer (D-37).

## Decision

A backtest replays stored decisions under a candidate decision config and may only tighten: at most two thresholds and one band boundary per round, at most one round a month (D-54). Simon approves by merging the pull request that carries the calibration record, after CI checks and a fresh-context Claude Code review, and gives the go for the production deploy. Candidate configs ship inactive in the image and a second pull request activates the adopted one (phase 5 slice 5A.2). Loosening and method changes run forward only.

| Rule | Detail |
|---|---|
| Window | `decision` rows at most 28 days old, non-null price inputs, current `decision_logic_version` (ADR 0009). Each row replays under its stored `buyer_profile` (D-04); the dashboard what-if is never stored or replayed. Rows outside the window are counted per label only |
| Replay check | Base and candidate equal to the stored config must reproduce every stored tier before any candidate is judged; any mismatch stops the run |
| Adoption | Fixed before each run. Among removed labelled alerts: bad = "Price not good enough", good = "Real deal, bought" + "Real deal, not needed"; other labels are reported only. Adopt only if bad >= 5, Wilson 95% lower bound of bad / (bad + good) > 0.5, and no "Real deal, bought" is removed. No override; a wrong rule is changed by a new record before the next round |
| Seller type | Candidates may be split by `sellerAccountType` (e.g. a private-seller premium) |
| Emergency | Tightening after a bad alert is allowed any time, recorded in the next calibration record |
| Loosening | Trial band: extra hits go to the digest only as `alert.kind = 'trial'` (ADR 0015), paid from the audit lane, adopted by the mirrored rule after 2 weeks |
| Method change | A fair-value method change needs its own proposed ADR superseding the method section of ADR 0017, acceptance criterion written before any parallel run |
| Poll interval | A pure function gives expected extra detection delay and calls per day per schedule. Pick the longest interval whose extra delay is under 10% of the lower quartile of deal lifetime (right-censored, biased long). Set per feed with `audit_event`; a week later daily calls must match the prediction within 10% (ADR 0016) |
| Committed record | `docs/calibration/`: label counts, alert counts, candidate config names, decision, approver, date |
| CLI output | Counts and ratios of our own alerts only (precision, Wilson intervals), never listing text, item keys or prices. Price-to-reference ratios are not printed; they and the delay/lifetime distributions stay in Postgres and on the Ops page (ADR 0024) and out of the committed record, to keep retention of listing-derived data minimal (D-11, good practice) |

## Alternatives considered

- **Tune thresholds freely after each review**: fits noise on 30 to 90 alerts and leaves no audit trail.
- **Automated threshold search**: overfits a small sample; the rule above answers the one question the data can answer.

## Consequences

**Positive**
- Every config change has a dated record, a count-based reason and a named approver.
- Calibration fits inside the 30-day price cap.

**Negative**
- Missed deals cannot be found by backtest; loosening needs a 2-week forward trial.
- Rounds are skipped when fewer than 30 labelled alerts fall in the window.

**Risks**
- Labels arrive too late for the window. Mitigation: recorded candidate tiers (slice 5A.2b) when the readiness view shows too few labelled rows.
- One person labels and approves. Mitigation: the adoption rule is fixed before each run with no override; the fresh-context review checks each record against the allowed fields.

## How we check it

- Unit tests of the adoption rule: 5 of 5 adopts, 7 of 8 adopts, 8 of 10 does not.
- Phase 5 AC-1: the replay check stops the run on any mismatch (planted-mismatch fixture).
- Phase 5 AC-2: replay test with `company` and `private` rows; an identical candidate gives zero changes, a tighter one never adds an alert.
- Phase 5 AC-3: CLI output has no title, item key, price or price-to-reference ratio (sentinel test).
- CI test on `docs/calibration/` rejects a record with a price, an item key or a field outside the allowed list.

## Revisit when

- Simon (or later other Intra AI people using the tool) wants to loosen from stored data (D-28), or retention of price columns changes (D-11, ADR 0014).
- Someone other than Simon labels or approves (reopens D-54).
- Alert volume rises enough that intervals can separate settings.
