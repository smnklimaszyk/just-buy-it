# Phase 3: Claude screening

As of 2026-10-19. Owner: Simon Klimaszyk, building alone with Claude Code (D-01). Slice 3 (ADR 0004): Claude screening (layer B) and its eval set; email, digest and feedback are in Phase 1. See [roadmap](../03-roadmap.md), [decisions](../02-decisions.md), [ADR index](../../adr/README.md).

It splits into **3a** (build and offline evaluation, team-built cases only) and **3b** (switch-on, section 2). Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## 1. Goal

Claude screens every alert-path candidate for scams and product mismatches. Code computes the verdict from checked evidence: **PASS** goes out instantly, **CAUTION** goes to the digest with a red-flag box, **BLOCK** is never emailed, only shown on the Deals page. Legitimate listings must mostly PASS. Deliverables: screened emails (verdict, reason codes, up to 3 verified quotes, as-of time), per-sector screening (base rubric plus GPU, RAM, gaming PC, ADR 0010), an eval set with a regression gate (ADR 0026), measured cost and latency, a defined result for every failure (global outage: degraded mode).

Not promised: detecting swapped dies, hollow modules, gutted cards or AI photos (https://platform.claude.com/docs/en/build-with-claude/vision).

## 2. Entry criteria

**3a:**
- Phase 1 delivered (feeds, call budget, rules, enrichment, recheck, SES outbox, ADR 0015 claims, digest, Deals and Ops). Phase 2 exit, or a recorded skip of layer A (F1).
- ADRs Accepted: 0006 (with `evals/` boundary rule), 0009, 0010, 0015 with **0031** (replaces the 0015 part B `deep` row), 0019, 0020, 0023, 0024, 0026 and 0028 (section 5 rules written in), 0027 (`buyer_profile`).
- Defaults (Simon may change): D-30 (image-only critical finding needs a confirmation call, else CAUTION), D-31 (per-listing failure at least CAUTION, reviewed; no server-side fallback), D-33 (under 3 usable images: at least CAUTION), D-34 (same-day review), D-35 (Langfuse for evals only), ADR 0023 (synthetic fixtures; team-built eval cases per ADR 0026), D-11 (quotes in `ebay_live`, deleted with content; `evaluation` keeps codes and numbers 180 days).
- Eval key home to be decided before 3.1 (GitHub Free: no environment secrets on private repos).

**3b:** 3a done; D-18 compliance pack signed (ADR 0018: DPA, transfer and legitimate-interest assessments, record of processing, Art. 14 text; ZDR requested, not awaited); production Anthropic key in a non-default workspace with spend limit, separate eval workspace (ADR 0011); ADR 0014 and 0022 Accepted.

**Out of scope:** auctions, market check (D-23), AI-photo detection, prompt caching (revisit above one deep call every 5 minutes).

## 3. Slices

Reference engineer-days (one engineer, no agents); agent speed unmeasured. Case building runs beside 3.1 to 3.9.

| # | Slice | Needs | Days |
|---|---|---|---|
| 3.0 | Config `evaluator.v1.ts`, `rubric.base.v1.ts` (model, effort, versions, seller-returns rules per `buyer_profile`, timeouts, caps); test that `claudeScreening` is false until `CLAUDE_SCREENING_APPROVED`; `evals/` import rule with failing fixture | Phase 1 | 0.5-1 |
| 3.1 | Eval harness: Zod cases with `sector`, `alert_eligible`, `photo_kind`; seeded split; runner through the port; per-sector report; template-corpus runner in CI; first 10 cases | 3.0 | 2.5-3.5 |
| 3.2 | Pre-scan, test-first: parse5; `foldForMatch()` with pinned confusables (https://www.unicode.org/reports/tr39/); strong and weak markers incl. bidi controls; hidden text via inline style and `hidden`; near-duplicate rule; masking to typed placeholders; head-and-tail truncation | 3.0 | 3-4 |
| 3.3 | Sector content, test-first: base codes (off-eBay payment or contact, picture only, screen photo, "defekt"/"Bastler", model contradicts title, AI-directed text). Sector signals, e.g. GPU burnt connector, Ti/D look-alikes, 48 GB mods; RAM ECC as desktop, SO-DIMM vs DIMM; PC "ohne Grafikkarte", "nur Abholung", financing. `composeScreening()` | 3.0 | 2-3 |
| 3.4 | `flagSellerRepeats()` in memory per poll run, boolean on the row; off by default (D-40) | 3.0 | 0.5-1 |
| 3.5 | `decideRisk()` and `routeAlert()` over `band`/`tier`; floors incl. `sector_not_evaluated`; two-High BLOCK counts an image finding only with a code signal or verified quote; both `buyer_profile` values; fast-check | 3.2, 3.3 | 2.5-3.5 |
| 3.6 | Adapter in `packages/llm`: no tools, no fallbacks, `inference_geo: "global"`; `zodOutputFormat()` with `messages.parse()`; limits checked in Zod; failure codes `refused`, `truncated`, `schema_invalid`, `timeout`, `request_rejected`, `unexpected_model`; `usage` with thinking tokens; image re-encode, long edge 2,576 px, memory only | 3.1, 3.2 | 4-5.5 |
| 3.7 | Worker: timeout/lease/expiry `screen.triage` 30/45/60 s, `screen.deep` 120/150/180 s, `screen.confirm` 60/75/90 s; `screen.audit`. Claims on `(item_key, stage, revision_hash, prompt_version)`; `deep` hash without price, end time (ADR 0031); takeover with `attempt + 1`, fenced write, `failed` at attempt 3. Concurrency 1; per feed 10 deep/hour (digest-only 5, escalations 3, shadow not counted); 20-min cap-wait expiry; lanes alert, audit, upgrade; reservation, breaker, kill switch | 3.5, 3.6 | 4.5-6.5 |
| 3.8 | Routing and templates: CAUTION one tier down; labels "screening failed", "not reviewed by Claude", "screening not yet validated"; ≤ 3 quotes of 120 characters, escaped; sector checklist | 3.7 | 1-2 |
| 3.9 | Deals filters "Needs a look", "Blocked", "Shadow"; labels with content age, shadow sampler (3 triage rejects and 2 rules rejects a day), shadow getItem tagged `shadow`, 3 blocked samples a day, Ops metrics, one Playwright flow | 3.7, 3.8 | 2-3 |
| 3.10a | Offline: case set, 30 templates, sweep, one held-out run, measured tokens, runbooks | 3.1-3.9 | 1.5-2 |
| 3.10b | Switch-on PR (`CLAUDE_SCREENING_APPROVED = true`, links compliance pack); image-fetch test; deploy on Simon's go; one observed week | 3.10a, D-18 | 1-1.5 + 7 days |

**Total:** 25-36.5 days, about **30 to 45.5** with integration (3a 6-9 reference weeks, then 3b 1.5). **Cut line** (fails toward CAUTION): confirmation calls (1.5), seller repeat signal (0.5-1), reservation while concurrency is 1 (0.5).

## 4. Acceptance criteria

| ID | Criterion | Proof |
|---|---|---|
| AC-1 | No request has `tools`, a fallback, item ID, seller username or ID, or image URL; all set `inference_geo: "global"` | Unit and contract test |
| AC-2 | Contact data masked before any call (`+49 151`, `0151/`, email, DE IBAN, "Tel.") | Golden, property tests |
| AC-3 | Quote verified only if found, after folding, at word boundaries in the text sent | Golden tests incl. Cyrillic `а` and masked text |
| AC-4 | Strong marker gives CAUTION or worse; weak markers add points only; duplicated hidden blocks are no marker | Property, golden tests |
| AC-5 | BLOCK never emailed; CAUTION never instant; more evidence never improves the verdict; failure never PASS | fast-check; Postgres |
| AC-6 | `routeAlert()` treats band and tier alike | Golden tests |
| AC-7 | Concurrent deliveries of one deep job give one call | Postgres, two workers |
| AC-8 | Crash before the call: takeover at attempt 2, 1 paid call; no `running` row older than lease + 2 min | Injected clock |
| AC-9 | Crash after the call: ≤ 3 paid calls; then `failed`, review entry, CAUTION; late results rejected | Throwing and slow fakes |
| AC-10 | Schema failure or `max_tokens` retried once; refusal never retried; all `usage` stored | Adapter tests |
| AC-11 | Price-only change makes no call; content change does, max 3 deep per 7 days, then `changed_after_screening` | Counting fake |
| AC-12 | Per-listing failure coded, to digest as "screening failed", reviewed; never degraded mode | Recorded shapes |
| AC-13 | Caps 10/5/3 per feed per hour hold; over escalation cap, no deep call | Always-failing triage |
| AC-14 | Not started within 20 min of triage: digest, "screening cap reached" | Injected clock |
| AC-15 | Shadow getItem ≤ 5/day, refused below 15 left in the 30/day "Screening extra getItem" line (ADR 0016) | `api_usage_hourly` |
| AC-16 | Every sector has fragment, signals, patterns; row records `sector_id`, fragment version; no held-out cases: `sector_not_evaluated` | Contract suite |
| AC-17 | Switch on: 3 same listings in one poll run set the flag, over two runs not; no seller key stored. Off: null | Unit, poll, sentinel |
| AC-18 | No eBay text in jobs, logs, eval traces or dump after purge | Sentinel via real dump script |
| AC-19 | `evaluation` rows: all versions, model asked and returned, tokens incl. thinking, cost, latency, attempt, image counts | Schema test |
| AC-20 | Gate fails on a newly failing held-out case, any critical failure, worse false BLOCK or PASS rate | Broken, all-CAUTION prompts |
| AC-21 | Held-out report meets section 5 targets; critical cases pass all 3 runs | `evals/reports/` |
| AC-22 | 30+ templates: scan plus `decideRisk()` alone move ≤ 5% out of PASS; no strong marker | CI test |
| AC-23 | Labels store labeller and content age; expired items show "codes only" | Playwright |
| AC-24 | 30+ contract calls per stage give p50/p95/p99; timeout about 2x p99 < lease < expiry; L = p95(triage) + 2 x p95(deep) + 30 s; L > 3 min: concurrency 2 or Simon accepts L in writing; production p95 ≤ L | Contract report; Ops |
| AC-25 | Alert-lane spend under budget all 7 days; workspace limit never hit | Console cost report |
| AC-26 | `output_tokens >= thinking_tokens`; 8 images, thinking and structured output parse on each candidate; Haiku accepts `effort: low` with thinking off | Contract tests |

## 5. Test strategy

- **Test-first in `packages/domain`:** folding, quotes, masking, detectors with must-not-fire cases (ZWJ emoji, hidden mobile duplicate, radio tabs, accordion), `composeScreening()`, `decideRisk()` caps (seller trust 30, price 25, condition 30, completeness 20, integrity uncapped), routing, caps, budgets, failure classification, `deep` hash. Hand-built fixtures in `fixtures/screening/`.
- **Postgres 18 integration:** claim lifecycle (AC-7 to AC-10), send enqueue in the decision transaction, breaker and degraded mode, retention sentinel, item groups never reach triage, image limits on a local fixture server.
- **Contract:** Anthropic by manual dispatch, eval key, team content only (AC-24, AC-26; thinking billed in `output_tokens`, https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost). eBay as a one-off container on `intra-ai`; in 3b, 8 image fetches with `getRateLimits` before and after, bytes not kept.
- **Where:** locally only changed tests, touched packages; PR CI without Anthropic calls; weekly held-out Batch drift run. Batch only for team-built cases; eBay content never goes through Batch.
- **Eval (pre-registered):** 30 tuning plus 40 scam and 40 legitimate held-out (110), ≥ 10 plus 10 per sector at full size, incl. few-photo private sellers, business templates with hidden duplicates, and injections inside them. Out-of-scope scams stay out of the denominator. No real listings. Targets: recall (not PASS) ≥ 0.90, false BLOCK ≤ 0.10, alert-eligible PASS rate ≥ 0.80 (assumption), template non-PASS ≤ 0.05; per sector with Wilson 95% intervals. Sweep rule `evals/sweeps/rule.v1.ts` on the tuning split: Opus 5.5 medium, Sonnet 5.5 high and medium, Haiku 5.5 xhigh and high; strongest qualifying wins unless a cheaper one is better by non-overlapping intervals; planning assumes Opus.
- **Statistics:** 22 of 24 caught gives 0.74-0.98 (36 of 40: 0.77-0.96); true recall 0.80 still passes 11.5% at 24, 7.6% at 40; 32 of 40 PASS gives 0.65-0.90; 0 of 30 templates allows up to 0.11. Targets catch regressions, not a recall claim.
- **"Screening not yet validated"** stays on alerts until, per sector, full size is reached (40 plus 40, sector 10 plus 10) and the last gate run met all targets.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Seller forces refusals or injects "report nothing" | Failures CAUTION, reviewed (AC-12); strong markers ruled in code (AC-4); eval cases measure suppression by injections in images |
| Triage passes 3-5x the assumed 10% | Caps, priority, expiry, budget guard |
| Eval set unrepresentative; too cautious | Shadow labels; PASS-rate and template targets in gate |
| Over-blocking honest private sellers with few photos | Under 3 images: CAUTION, not BLOCK; daily blocked samples; false BLOCK target |
| Model update changes verdicts | Pinned snapshot ID checked against response `model`; upgrade via shadow lane, then config PR |
| Quotes keep eBay text in mailboxes | Quote cap (3.8); mailbox auto-delete rule (Phase 1) |
| Personal data reaches Anthropic | Masking; compliance pack; API data deleted in 30 days, flagged content kept up to 2 years, classifier scores up to 7 years (https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data); ZDR request |
| Shared host load | Measured in production week; cap-wait expiry |
| Labelling or case building stalls (one person) | ≤ 5 shadow items a day; agents draft text cases, Simon checks each |

## 7. Owner time and cost

Cases to 3a size (78): 56-91 hours over 3-5 weeks; full size (110): 79-129 hours. Templates: 1-1.5 days. Compliance pack: 2-4 days. Labelling: 5-10 minutes per item a day for 4-6 weeks.

Prices (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-19): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per million tokens, Batch 50% off. Deep call (8 images, 4-8k text, 2.5-9.5k output tokens): Sonnet $0.073-0.19, Opus $0.146-0.38. Per month: Opus $34-87, worst case $79-205; Sonnet worst case $40-103. R4 worst case $2.60-6.80/day on Opus exceeds the old $5 guard, so week one uses $10 alert, $1.50 audit, workspace limit $360/month, reset from measurements. Eval: sweep $13.47-34.65, held-out run $10-27 (full size $17-46), per-run cap $60.

## 8. Exit gate

1. AC-1 to AC-20, AC-22, AC-23 green in CI; AC-21, AC-26 reported.
2. Held-out ≥ 24 plus 24, 6 plus 6 per sector, one per category; AC-21 met.
3. Compliance pack signed, linked in the switch-on PR.
4. 7 production days: one screened instant alert and one CAUTION; AC-24, AC-25 met; reviews labelled or recorded as missed; feeds with >5% failures and sectors with >50% CAUTION investigated.
5. Budget reset from measured tokens in a config version; runbooks written; ADR 0031, 0026, 0028 Accepted; all PRs merged under D-37 (CI green, fresh-context review, Simon reads `evals/`, `docs/adr/`, `.github/` diffs); whole-pipeline review findings fixed or recorded.

Without a signed compliance pack the phase ends at **3a done**: screening off, alerts say "not reviewed by Claude".
