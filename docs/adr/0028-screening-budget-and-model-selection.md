# ADR-0028: Screening budget lanes, shadow sampling and model selection

**Date**: 2026-10-19
**Status**: proposed (waits on D-32 and D-34; owner decides before the slice 3 sweep)
**Related**: ADR 0008, 0009, 0011, 0015, 0019, 0020, 0024, 0026; D-01, D-29, D-37
**Needed by**: slice 3a (lanes, shadow sampler); slice 3b (rule, CI check).
**Follow-ups**: 0015 adds stages `triage_shadow` (`triage-shadow-v1:`) and `deep_shadow` (`deep-shadow-v1:`), which never enqueue a next stage or `decide`; 0026 adds the Haiku candidates and this unit cost to its sweep cost table; 0024 shows spend per lane, upgrade-lane end date and label load.

## Context

- Per million tokens in/out: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 (2026-10-19).
- An image costs `ceil(w/28) x ceil(h/28)` tokens, at most 4,784 at the 2,576 px limit ADR 0019 uses.
- Anthropic advises a fresh effort sweep and comparing Haiku at `xhigh` with Sonnet.
- Held-out split: 40 scam and 40 legitimate cases. Wilson 95% intervals separate candidates only at gaps of 20 to 30 points.
- Lanes spend in production once the eval gate is green. No seller identifiers go to Claude.

## Decision

Claude spend runs in three lanes with separate daily caps and no borrowing. Model and effort come from a rule committed as code before the sweep, and CI checks that the active config follows from it.

| Item | Rule |
|---|---|
| Cost per deep call (assumption) | 8 images at 2,576 px, 4-8k text in, 2.5-9.5k out: Sonnet 5.5 $0.073-0.188, Opus 5.5 $0.146-0.375; `image_confirm` up to $0.031 / $0.061; 135 deep calls a month: $10-25 Sonnet, $20-51 Opus |
| Alert lane | `triage`, `deep`, `image_confirm`. $10 a day in week one (a 40% triage pass rate needs $2.60-6.80), then reset from measured tokens by PR. When spent, ADR 0019 degraded mode |
| Audit lane | `triage_shadow`, `deep_shadow` with `purpose = 'sample'`. $1.50 a day; when spent, sampling stops for the day |
| Upgrade lane | `deep_shadow` with `purpose = 'candidate'`. No budget by default; decision config `upgrade_shadow: { candidate_config_id, starts_on, ends_on, daily_budget_usd }`, at most 14 days |
| Reservation | Worst case reserved before each call; deep covers two `image_confirm`; settled from `usage` |
| Workspace limit | $360 a month (31 x $11.50, ADR 0011; a unit test checks it covers 31 days of both caps). An upgrade PR raises it first (template checklist), so the local guard trips first. Evals use their own workspace |
| Audit queue | `screen.audit`, concurrency 1, lowest priority; never enqueues a next stage, `decide` or an alert |
| Shadow sample | Calibration (4-6 weeks): 3 `deep_shadow` on triage rejects plus 2 `triage_shadow` on rules rejects a day; after: 1 `deep_shadow`. Blocked review: 2 per weekday, labels only |
| Label load | About 195 a month in calibration (25-50 min a day), 75 after. `review_due_at` = content expiry; content age stored per label (D-34) |
| Candidates (strong to cheap) | Opus 5.5 `medium`, Sonnet 5.5 `high`, Sonnet 5.5 `medium`, Haiku 5.5 `xhigh`, Haiku 5.5 `high` |
| Qualifying (tuning split, 3 runs per case) | misses no critical case another catches; scam recall >= 90%, false BLOCK <= 10%, PASS on alert-eligible legitimate >= 80% (D-46); p95 cost x daily volume <= 50% of the alert lane |
| Choice | Strongest qualifying, unless a cheaper one has a better, non-overlapping Wilson interval on recall or false BLOCK. None qualifies: no config, gate stays red. The winner runs once on held-out (ADR 0026); if it fails, no config is activated; go back to tuning and re-sweep |
| Upgrade | Monthly deprecation check. Candidate passes gate and rule; shadow budget 1.5 x p95 x 7-day volume (about $2.50 a day, $35 per 14 days); 30 paired evaluations, one extension of up to 14 days by a new PR; `shadow_report` compares PASS/CAUTION/BLOCK rates, failure codes, latency and cost; switch by PR |

**MVP note (2026-10-21)**:

- No lanes, no shadow sampling, no model sweep. The model is fixed at `claude-sonnet-5-5` with effort `medium`; the env accepts no other value.
- Two daily caps per Berlin day, both checked in one reservation statement on `app.llm_usage_daily` before each call: `CLAUDE_DAILY_CALL_LIMIT` (default 40) and `CLAUDE_DAILY_SPEND_LIMIT_USD` (default 2, kept in micro-USD). Each call reserves its worst case, USD 0.062: at most 16,000 input tokens (12,000-byte user message, 3,000-byte system prompt, 1,000 tokens for framing and the schema) at USD 2 per million, plus `max_tokens` 3,000 output tokens at USD 10 per million. After the call the reservation is settled from `usage`; when no usage came back the worst case is kept as spent. Retries count against both caps.
- There is no larger retry on `truncated`; the cap is the cost bound. With worst-case calls only, the spend cap stops at 32 calls; with typical calls the call cap stops at 40, at about USD 0.40 to 1.30. The real worst case is USD 2 a day, about USD 60 a month.
- Recommended to the owner, not built: a Console workspace spend limit of USD 75 a month for this key.

The sweep runner refuses to start unless `evals/sweeps/rule.v1.ts` is committed and unchanged; the report records the rule path, `rule_commit` and start time. CI job `evaluator-config-guard` runs on PRs that add an evaluator config or change `evaluator_config_id`. It fails unless the config names a `sweep_report` on the branch, `rule_commit` is an ancestor of it, the rule is unchanged since, and the rule returns that config. A changed rule is a new file (`rule.v2.ts`) with a new sweep.

## Alternatives considered

- Opus 5.5 `medium` without a sweep: nothing is measured and upgrades have no baseline.
- Cheapest candidate meeting targets: a weak model passes by chance about 8% of the time, to save $10-26 a month.
- Leaving Haiku out: it offers the only large saving.
- One budget, audit pausing at 80%: it cannot fund both audit and upgrade shadow.
- The plan's sample: 790 labels a month is too many for one person.
- Rule in a README: nothing stops it changing after results are seen.

## Consequences

- Positive: audit and upgrade never take alert money; the model choice traces to a report and an earlier rule.
- Negative: three lanes and a queue to build; the likely winner, Opus 5.5, costs $10-26 a month more than Sonnet; cheap-stage recall is less certain; the workspace limit is raised by hand.
- Risks: cost above assumptions (measure in week one, reset caps by PR); labelling backlog (Ops page, label from codes, lower the sample; a minimum label count gates phase 5 backtests); a rule rewritten after a sweep (fresh-context review and Simon's diff reading, D-37).

## How we check it

- fast-check: no lane exceeds its cap or borrows; upgrade lane idle outside its window; Berlin day across CEST/CET.
- Postgres test: `screen.audit` never enqueues `decide`; a spent audit lane leaves alert jobs running.
- `rule.v1.ts` unit tests: critical miss and 5 of 40 false BLOCK disqualify; overlap picks strongest; no qualifier returns none. Guard tests on a scratch git repo.

## Revisit when

- Week-one cost per deep call is outside $0.05-0.40.
- Calibration labels show a rejected real deal or scam twice.
- The held-out split reaches about 100 scam cases.
- A model in use is deprecated, or a new one is wanted.
- Labels miss due dates two weeks running.
