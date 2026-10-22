# ADR-0020: Risk verdict from code with typed, verified evidence

**Date**: 2026-10-19
**Status**: proposed
**Deciders**: Simon Klimaszyk (D-01)
**Related**: ADR 0004, 0006, 0009, 0015, 0017, 0018, 0019, 0023, 0027, 0028

## Context

- Family caps: seller trust 30, price anomaly 25, condition and use 30, completeness 20, integrity uncapped. PASS 0-24, CAUTION 25-59, BLOCK 60+.
- Three of four critical signals are visual (screen photo, foreign watermark, burnt 12VHPWR connector); a quote cannot verify them.
- Exact matching fails on look-alikes, typographic quotes, soft hyphens, HTML whitespace ([UTS #39](https://www.unicode.org/reports/tr39/)). Injection removes findings, which quote checks miss. Masked contact data cannot be quoted (ADR 0018).
- Claude screening is optional. Seller-type and seller-scoped rules are in scope; no seller identifier goes to Claude; every call is under the call budget (ADR 0028).

## Decision

A pure `decideRisk()` in `packages/domain` computes the verdict from code signals and from model findings whose typed evidence code verified. Only verified items can BLOCK. A code scan before any Claude call finds injection markers; no model output removes them.

| Rule | Detail |
|---|---|
| Finding | Union in `domain/src/risk/finding.ts`, closed `code` enum, rubric-fixed severity. `text_quote` {title/description/returns, 3-300 chars}; `image_ref` {image_index, observation max 200}. Zod schema in `packages/llm`. |
| Text check | `foldForMatch()` on quote and stored sent text: NFD, drop Default_Ignorable, ASCII quotes/dashes, UTS #39 prototypes (pinned, SHA-256), NFD, case fold, collapse whitespace; word-boundary match; `match_level` exact/light/skeleton. |
| Image check | Critical `image_ref`: one confirmation call, max 2 per listing. Input: that image only, no tools, listing text or first-call output; hash mismatch on re-preparation gives CAUTION. Balanced three-answer question from rubric config; only the matching answer verifies. Stage `image_confirm:<code>:<index>`, revision hash covers image SHA-256 (ADR 0015), alert lane; shadow runs use audit lane, `image_confirm_shadow:<code>:<index>`. Model, effort, `max_tokens` are evaluator-config fields (ADR 0009). Max about $0.03 on Sonnet 5.5 if `max_tokens` 2000 (to measure). Budget refusal: CAUTION "image check not run". High/medium image findings score, unverified. |
| Unverified | Failed quote scores 0; unverified critical/high sets a CAUTION floor. Seller claims never lower a score. |
| Code signals | Raw title and description, before masking. Critical: `payment_outside_ebay` (IBAN, payment phrase), `contact_outside_ebay` (contact data plus an off-eBay invitation from the phrase list); contact data alone (legal notice) is Medium `contact_data_present`. Strong (High): `reviewer_directed_phrase`, `bidi_control`, `confusable_in_model_token`, `hidden_directive_text`. Weak (Medium): `soft_hyphen`, `zero_width`, `bidi_mark`, `hidden_text`. Hidden = `hidden` attribute or inline style. A model finding with a code-signal code adds no points. VAT facts (`vat_class`, `vat_invoice_phrase`, `price_may_exclude_vat`) feed band checks and email flags only. |
| BLOCK | 60+ verified points, a verified critical, or two verified Highs from different families. Two or more weak markers of different kinds count as one High signal, never part of a BLOCK pair. Weak markers alone add points but set no floor. |
| CAUTION | 25-59 points (all items), strong marker, unverified critical/high, under 3 usable images, language not de/en, incomplete coverage, per-listing model failure. |
| Rules-only | `CLAUDE_SCREENING_APPROVED` false, kill switch, or degraded mode (ADR 0019): `screening: "off"`, model floors skipped; code signals, markers, caps, language floor apply; image floor counts getItem images. `reviewed: false`, "not reviewed by Claude". Slice 1: a code scam signal goes to the digest with a red-flag box (ADR 0004). |
| Seller trust | Thin reputation, `seller_account_type`, returns rules (ADR 0027), `seller_repeat`: on or off by rubric config. `flagSellerRepeats()` in the poll run matches title and price per seller, key in memory only, sets a listing-row boolean (never reset, deleted with the listing); High. Misses repeats across polls and feeds. `buyer_profile` never changes the verdict; private-seller premium is in the tier function (ADR 0017). |
| Code location | Only `packages/ebay/src/description/parse.ts` imports parse5, pinned 8.0.1, after a supply-chain review. Domain logic in `packages/domain/src/risk/`. |

**MVP amendment (2026-10-21), owner decision Q7**:

- No `decideRisk()` with families and verified quotes yet. `packages/domain/src/screening/verdict.ts` takes the worse of the model verdict and the code floors; code never lowers a model verdict. No parse5, no look-alike folding.
- Code floors from a scan of the raw title and description, before masking. Scam floors, which give `block` with `blocked_by_code = true`: an IBAN with a valid ISO 13616 check sum, and an off-eBay payment phrase (for example `paypal freunde`, `friends and family`, `western union`, `vorkasse per überweisung`, `nicht über ebay`). Caution floors: `überweisung` or `vorkasse` alone, contact data with an invitation to make contact off eBay, hidden characters, and phrases addressed to a reviewer or an AI. Model `product_match = mismatch` gives at least caution; a failed or skipped screening gives caution with `screened = false`.
- **Routing:** a `block` from the model alone is still emailed, with the subject and body marked "Claude says block" and the model's reason. The email is suppressed only when a code scam floor fired; such an alert is shown on the dashboard's Blocked page with its signal codes. Pass and caution are emailed; caution with a warning box.

## Alternatives considered

Rejected: no caps (over-blocks private sellers); positive offsets (seller text lowers score); exact matching only (fails adversarial text, no images); model detects injection (judges itself); every marker High (soft hyphen plus a High blocks); full CSS cascade (big dependency); image criticals capped at CAUTION (red flags get ignored; fallback if evals show no gain); yes/no confirmation (leading).

## Consequences

- **Positive**: every BLOCK is verified; suppression leaves a code marker; backtestable (ADR 0009).
- **Negative**: we own fold code, confusables, de/en phrase lists; confirmation costs latency and money; style-block hiding unflagged.
- **Risks**: marker false positives; fold false matches (1/I/l, 0/O); confirmation echoes a wrong first call; in-image instructions unseen (accepted v1).

## How we check it

- Golden: each BLOCK path, caps, unconfirmed image + strong marker = CAUTION, lone soft hyphen = PASS, rules-only.
- fast-check: verified signals never lower the verdict; code signals stay; caps hold; `buyer_profile`, VAT class and (seller-type rules off) `sellerAccountType` never change it.
- Fold tests (NFC/NFD, Cyrillic, `3O9O` is `skeleton`); HTML scan fixtures.
- Crash replay on real Postgres: at most the ADR 0015 call count, one stored answer, two claim rows for two critical image findings, a third not called.
- Budget: alert lane exhausted gives unverified image, "image check not run", no call. Type test: Zod output equals `Finding`.
- Marker rates: clean corpus (50+ synthetic) no strong, weak at most 5%; before slice 3, 14 production days, strong at most 1%.
- Evals (ADR 0023): 8+ injection cases; strong marker with PASS fails; image-only criticals non-PASS in all 3 runs.
- Lint: domain has no runtime deps and bans `fetch`, `XMLHttpRequest`, `WebSocket`, timers, `crypto`, `Math.random`, `Date.now()`/`new Date()` (ADR 0006, 0008); confusables SHA-256 checked.
- PR template and the fresh-context review (D-37, ADR 0029): severity, cap, phrase-list, grading or question changes need a new numbered rubric config file.

## Revisit when

- Confirmation adds no precision, bad answers on clean images exceed 10%, or image-only critical BLOCK rate is below 0.5 with 6+ cases.
- A marker stays over its limit after tuning, or evals show style-block injection.
- ADR 0027 changes, or a model, Node or Unicode change shifts fold rates.
