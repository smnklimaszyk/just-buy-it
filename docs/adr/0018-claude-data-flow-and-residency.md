# ADR-0018: Claude data flow, residency and personal-data minimisation

**Date**: 2026-10-19
**Status**: proposed (compliance documents wait on D-18)
**Related**: ADR 0006, 0009, 0014, 0019, 0020, 0023, 0024, 0027; D-04, D-18, D-35, D-37

## Context

- First-party API: `inference_geo` is `"global"` or `"us"` (1.1x); workspace storage is US only ([residency](https://platform.claude.com/docs/en/manage-claude/data-residency)).
- Retention: inputs and outputs 30 days, flagged up to 2 years, flag scores up to 7 years ([retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)); no training by default ([training](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)). Zero data retention (ZDR) only through sales; Batch API not ZDR-eligible, 29 days ([API retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)).
- The DPA with SCCs is part of the Commercial Terms; no separate signature ([DPA](https://privacy.claude.com/en/articles/7996862-how-do-i-view-and-sign-your-data-processing-addendum-dpa)).
- Unverified: a separate retention rule for "Covered Models"; Anthropic's EU-US Data Privacy Framework status.
- Private sellers are natural persons: text holds phones, emails, IBANs, names; photos show names and addresses. "No seller identifiers sent to Claude" stays. GDPR applies in full: no household exemption (D-04).
- Images: API 10 MB each, 32 MB per request; Bedrock and Google Cloud 5 MB, base64 only; Bedrock 20 MB per request; 2,576 px long edge ([vision](https://platform.claude.com/docs/en/build-with-claude/vision)).

## Decision

Every Claude call (triage, deep evaluation, the ADR 0020 single-image confirmation) goes through one request builder in `packages/llm` to the first-party API with `inference_geo: "global"`, gated on a code constant set only after the compliance documents are signed.

| Sent | Rule |
|---|---|
| Title, description, triage summary | Scan raw HTML first (ADR 0020); then visible text, zero-width and bidi characters stripped, phone/email/IBAN/detected names become `[PHONE]` `[EMAIL]` `[IBAN]` `[NAME]` |
| Seller | Feedback score, positive %, business or private |
| Images | Up to 8, re-encoded base64, no metadata, max 2,576 px and 5 MB each; request max 18 MB. Caps follow Bedrock (5 MB, 20 MB) so a later EU adapter needs no change |
| Never | Image URLs, item IDs, seller username or ID, `buyer_profile` |

- Only `packages/llm` and `evals/` import `@anthropic-ai/sdk`; the ListingEvaluator port has no Anthropic types.
- Sent text is stored in `ebay_live` (hash on the evaluation row) for checks that quoted evidence appears in it; deleted under ADR 0014. Image bytes are not stored.
- The confirmation call re-encodes the image and compares its SHA-256 with the stored first-call hash; mismatch gives CAUTION.
- No eBay content via the Batch API; no processor besides Anthropic. Langfuse only for eval runs on team-owned cases, no production traces (D-35); telemetry is numeric.
- `CLAUDE_SCREENING_APPROVED = false` in `packages/domain/src/compliance/claude-screening-approval.ts`. While false, production wires the rules-only evaluator; the kill switch row can only turn screening off.
- Compliance documents in `docs/compliance/claude/`, each ending `Signed-off-by: <name>, <YYYY-MM-DD>` by Simon, never an agent: 01 Commercial Terms with DPA (dated copy), 02 transfer impact assessment, 03 legitimate interest (Art. 6(1)(f)), 04 Art. 30 record, 05 Art. 14 position (privacy page), 06 service-provider entry, 07 ZDR request date (go-live does not wait).

**MVP amendment (2026-10-21), owner decision Q1**:

- **Simon, the owner, decided on 2026-10-21 that Claude screening runs in the MVP before the compliance documents above (the D-18 pack) are signed, and accepted the risk of doing so.** His grounds: contact data is masked before anything is sent, and no seller username or ID, item ID, URL, image or buyer profile is sent. The pack is still required; it stays a Phase 3b item, and this decision does not replace it.
- There is no `CLAUDE_SCREENING_APPROVED` constant in the MVP. Screening runs when `ANTHROPIC_API_KEY` is set and both daily caps are above 0 (ADR 0028 note); `CLAUDE_DAILY_CALL_LIMIT=0` and a worker restart turn it off.
- What is sent, built by `packages/llm/src/request.ts`: segment and a one-line description, title, condition and condition description, prices and the owner's maximum, seller feedback score, positive percentage and account type, return terms, item country (no postal code or city), listing age, up to 30 item specifics, image count, the description and the rule flags and code signals. The description is stripped of `script`, `style`, `iframe` and `noscript` blocks and all tags, entities are decoded, zero-width and bidi characters removed, phone numbers, email addresses, IBANs and `wa.me`/`t.me` links masked as `[PHONE]`, `[EMAIL]`, `[IBAN]`, `[CONTACT_LINK]`, then cut to the first 4,500 and last 1,500 characters. The whole user message is at most 12,000 bytes. Names are not masked.
- Text only, no images. Plain `fetch` in `packages/llm`, no `@anthropic-ai/sdk`; `inference_geo: "global"`; model `claude-sonnet-5-5`. The masked description as sent is kept in `ebay_live.listing_content.description_text` and deleted at content expiry; the model's reason in `ebay_live.screening_text`, deleted with the content.
- Recommended to the owner, not built: an Anthropic Console workspace spend limit of USD 75 a month for this key, and a key rotation after the live acceptance.

## Alternatives considered

- **Bedrock or Google Cloud EU now**: EU region for Sonnet 5.5 and Haiku 5.5 unverified; second cloud account.
- **Rules only**: no image screening; stays the F1 fallback.
- **ZDR before go-live**: no deadline from sales.

## Consequences

**Positive**: the scan still catches contact data and injection markers; the dashboard cannot turn screening on.

**Negative**
- Global inference and US storage are transfers; 30 days to 2 years versus our 6-hour window.
- Name masking is best effort; images cannot be masked. Stripped zero-width and bidi characters only reach the scan.
- The image re-encoding library is a new dependency: maintenance check needed.
- No production traces: debugging uses the evaluation table, logs and team-owned replays.
- Switching screening on needs a deploy with Simon's go.
- No human reviewer (D-37; the `main` ruleset enforces CI, not a review): the fresh-context Claude review may share the writer's blind spots, so Simon's read of the constant and compliance-document diffs is the last check.

**Risks**
- Simon rejects global inference (D-18): build the Google Cloud adapter, screening off until then (`"us"` does not help).
- Anthropic changes terms: monthly terms diff.

## Changes to other records

- **0020**: quotes are checked against the stored sent text, with the same NFC, whitespace and look-alike folding applied to both.
- **0023**: fixtures shared by masking and the verifier: quote spanning a placeholder, quote next to a removed zero-width character, look-alikes in a model number.
- **0024**: hourly `usage.inference_geo` mismatch alert; the Langfuse rule above.
- **Catalogue**: "signs the DPA" becomes "accepts the Commercial Terms with the incorporated DPA".

## How we check it

- Builder test: a listing with phone, email, IBAN, "Gruß, Max Müller", username, item ID, URLs, zero-width and bidi characters; triage and deep evaluation bodies contain none of them; images base64, at most 8, within caps, no EXIF; body at most 18 MB; `inference_geo` `"global"`; no `buyer_profile`; scan still reports findings; a changed image on the confirmation call gives CAUTION.
- dependency-cruiser enforces the SDK import rule.
- Lint: `batches` and `/v1/messages/batches` banned outside `evals/**`; eval cases need `source` `synthetic` or `team-owned`.
- CI on every PR fails if the constant is true and a document is missing or unsigned; constant false gives rules-only.
- Telemetry allowlist test; production env rejects `LANGFUSE_*`.

## Revisit when

EU storage, EU `inference_geo` or an EU region for the chosen models; D-18 decided; ZDR answered; tool use returns (ADR 0019); cited Anthropic pages change.
