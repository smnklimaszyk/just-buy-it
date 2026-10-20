# Gates and eBay evidence

Evidence for the eBay checks in [ADR 0003](../adr/0003-ebay-licence-gates-and-evidence-standard.md). No listing content, no tokens, no secrets in this file.

## Deletion subscription (Phase 0 S3, A6)

| Item | Value |
|---|---|
| Date saved | 2026-10-20 |
| Endpoint URL | `https://deals.intra-ai.de/ebay/account-deletion` |
| Keyset status after saving | Active; first notification with a verified signature at 2026-10-20 07:15 UTC |
| Portal screenshot (without the token) | not taken |

## Production App ID

| Item | Value |
|---|---|
| App ID | in the server `.env` only |
| Recorded on | 2026-10-20 |

## Gate 1a (Phase 0 S5, A16)

One `item_summary/search` on `EBAY_DE` with the production keyset returns EUR prices.

| Item | Value |
|---|---|
| Request ID | not captured |
| Time (UTC) | 2026-10-20, shortly after 2026-10-20 07:15 |
| HTTP status | 200 |
| `total` | 57 (q="RTX 3090", category 27386, used, fixed price, delivery to DE) |
| Currencies | EUR only |

## API License Agreement footer

| Date read | Footer date | Changed since last read |
|---|---|---|
| 2026-10-19 | Sept 3, 2025 | no |

## Phase 0 exit record

Signed by Simon when the Phase 0 exit gate is met ([phase 0](../planning/phases/phase-0.md) section 11).

Signed: ____ Date: ____
