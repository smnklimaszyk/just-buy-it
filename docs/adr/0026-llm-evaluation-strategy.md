# ADR-0026: LLM evaluation of the listing screener

**Date**: 2026-10-19
**Status**: proposed; targets are proposals pending D-29, to be settled before slice 3 build.
**Related**: ADR 0011, 0018, 0019, 0020, 0022, 0023, 0024, 0028

## Context

- 9 of 10 scams caught gives a Wilson 95% interval of [0.60, 0.98]. A screener with true recall 0.80 passes a 0.90 gate with probability 0.38 at 10 cases, 0.08 at 40.
- Claude cannot detect swapped dies, hollow modules or AI-generated photos ([vision](https://platform.claude.com/docs/en/build-with-claude/vision)).
- Batch API: 50% off, most batches done within 1 hour, unbilled expiry after 24 hours ([batch](https://platform.claude.com/docs/en/build-with-claude/batch-processing)). Data is kept 29 days without zero data retention, so Batch is for team-owned content only (ADR 0018).

## Decision

Each change to evaluator config, prompts, schema, model, effort or rubric passes a held-out regression gate (Batch, 3 runs per case) before merge, in the `eval` workspace.

| Item | Rule |
|---|---|
| Cases | Cases sit in `evals/cases/<split>/<id>/`, built with the ADR 0023 builder and Intra AI photos, `source` = `synthetic` or `team-owned`. Simon labels; a fresh-context session reviews. CI rejects eBay URLs and non-synthetic IDs. |
| Authoring | Text is written, not pasted, with every incidental detail changed. Agents never see real listings. Simon attests in the PR template. |
| Scope | In: payment or contact off eBay, box or picture only, screen photo or watermark, burnt connector, "defekt"/"Bastler"/"ungetestet", contradicting model numbers, injection or hidden text. Out, counted but never in recall: swapped die, hollow module, gutted card, AI-generated or stolen photo. |
| Splits | Tuning serves prompt work and the sweep; held-out serves gates only. New cases go to held-out until it has 40 scam (3+ per category) and 40 legitimate cases, with hard negatives. |
| Metrics | Recall (scam not PASS), BLOCK recall, false BLOCK, PASS rate on alert-eligible legitimate cases (at least 3 usable images, German or English, no strong marker). Other false CAUTION, image-only critical signals and Wilson intervals are informational. Reports hold no case content. |
| Targets (proposed) | Recall at least 0.90, false BLOCK at most 0.10, alert-eligible PASS at least 0.80, template-corpus non-PASS at most 0.05. They apply once held-out has 24 of each. |
| Gate | No case that passed the baseline (2 of 3) fails, `critical` cases pass 3 of 3, injection suppression is not worse, targets are met. With an empty held-out split the gate cannot pass and slice 3 cannot go live. |
| Rotation | A held-out case moves to tuning and is replaced if it drove a prompt change, regressed then passed in one PR, or was opened during evaluator work. This happens in a PR touching only `evals/cases/`; the count reads one lower until replaced. |
| Run cap | After 3 gate runs a PR is closed, rotated and restarted. A collect dispatch is not a new gate run. An expired batch sets `error`; its rerun counts only if it produced a result. |
| Status | `ci.yml` job `evals-required` (no path filter, no secrets) posts `evals/held-out` pending if the diff hits `.github/evals-paths.txt` (read from base), else success. Simon dispatches `evals.yml` to submit; collecting by `batch_id` posts the result for the SHA recorded at submit. If the branch moved, the new head stays pending. |
| Baseline | `evals/baselines/<sha>.json` is committed in a follow-up PR touching only `evals/baselines/`; CI checks it against the report artifact. |
| Weekly | A Batch run on `main` is collected 24 hours later; drift opens an `evals-drift` issue. |
| Label | Alerts say "screening not yet validated" until held-out has 40 scam and 40 legitimate cases and the last gate passed. Earlier go-live needs one case per category and all critical cases passing. |
| Ops page | Spend, gate runs per week, held-out size, label state. After go-live, Scam and Wrong product feedback and shadow-sample labels inform target revisits, not the gate. |

**Cost** (Opus 5.5, ADR 0028 units; Sonnet about half). Per month: 2 gates, 4.33 weekly runs, 8 tuning passes; 80 held-out, 30 tuning cases. Gate $17.52-45.00, weekly $5.84-15.00, tuning pass $4.38-11.25, quarterly sweep $13.47-34.65: about $95-245 a month, $100-257 with sweeps. Workspace limits follow ADR 0011; its $60 run cap holds a gate up to about 106 cases.

## Alternatives considered

- **Wilson lower bound as gate**: needs 35 flawless or about 140 cases.
- **One set for tuning and gating**: measures fit, not quality.
- **Gate on every push, or synchronous gates**: $18-45 a push, or double cost above the cap.
- **Nightly runs**: pinned snapshots make reruns mostly noise; about 7 times the weekly cost.
- **Encrypting held-out**: Simon would hold the only key and directs prompt work; rotation and the cap suffice.

## Consequences

- **Negative**: 110 cases take 79 to 129 hours of Simon's time, agent savings unmeasured; an evaluator PR waits about an hour, at worst a day; version 1 makes no recall claim.
- **Risks** (mitigation in brackets):
  - Held-out leaks into tuning, since prompt agents can read cases (rotation, run cap, weekly gate count).
  - A copied listing (attestation, review).
  - Hand-built cases differ from real ones (hard negatives, field metrics, shadow sample).
  - Run-to-run variance makes gates flaky (majority of 3; unstable cases reported, not gated, unless critical).
  - A PR edits `evals.yml` to post success (the agent token cannot change workflows, dispatch `evals.yml` or post statuses; policy checks run from base). The `main` ruleset requires only `checks` and `zizmor` (D-37), so this status holds by convention and Simon reads `.github/` and `evals/` diffs.
  - A spend limit trips mid-gate (separate workspace; status `error`).

## Revisit when

- D-29 is answered, or Simon asks for a recall claim.
- Held-out reaches 40 scam cases (rerun sweep), 106 (cap) or 140 (lower bound).
- Field labels disagree with evals two months running, Anthropic changes snapshots or Batch, or gates wait over a day twice a month.
