# ADR-0003: eBay terms: gate 1a only

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0001, 0002, 0004, 0007, 0009, 0011, 0013, 0014, 0016, 0018; D-01, D-03, D-07, D-49

## Context

- The tool calls the eBay Browse API with a production keyset. The API License Agreement (footer "Sept 3, 2025", [link](https://developer.ebay.com/join/api-license-agreement/)) governs that use.
- eBay may amend the agreement at any time, effective 30 days after posting (11.2).
- The earlier plan split access into gate 1a (technical), 1b and gate 2 (licence steps). Licence review is the operator's responsibility; out of scope for this repo.

## Decision

Gate 1a stays as a technical check and gate 3 (ADR 0002) stays unchanged. Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

| Gate | Passes when | Evidence | Unlocks |
|---|---|---|---|
| 1a | One `item_summary/search` on `EBAY_DE` with the production keyset returns EUR prices, after the deletion endpoint is live at https://deals.intra-ai.de/ebay/account-deletion and the keyset is active (ADR 0013) | Request ID, time, status, `total`, currency in `docs/compliance/gates.md`; no listing content | Scheduled production polling (ADR 0004, 0016) |
| 3 | A person always buys through eBay checkout; no bidding or buying automation, no scraping, no browser automation | ADR 0002 | Always in force |

Also in force: the deletion endpoint, eBay call limits and the call budget (ADR 0016), minimal retention of listing content (ADR 0014), no seller identifiers sent to Claude (ADR 0018), no resale or sharing of eBay data, no eBay content in training or evaluation sets.

## Alternatives considered

- **Do not use the eBay API (F2, saved-search emails)**: gives up query control, fair value and screening; stays the fallback if the keyset is lost.

## Consequences

**Positive**
- Phase 1 to 4 can run on production data once gate 1a passes.
- One small technical gate instead of a gate table and evidence rules.

**Negative**
- The repo does not check licence terms; that review sits with the operator.

**Risks**
- eBay may revoke the keyset or suspend accounts, possibly including the eBay account used for buying. Everything on production data then stops and eBay content must be deleted within 10 days (section 16).
- Terms change under 11.2.

## How we check it

- `docs/compliance/gates.md` records gate 1a evidence (Phase 0 A16), the production App ID, the deletion subscription and the agreement footer date last read.
- Before gate 1a is recorded, the worker registers no production poll schedules (unit test).
- Contract runs and polling count every Browse call through the ADR 0007 counter and stay inside the ADR 0016 budget.
- The ADR 0009 kill switches stop polling and each layer without a deploy, which is the response to a keyset warning or revocation.
- Simon re-reads the agreement footer before switching on each layer and at least every 90 days; the monthly terms diff (D-49) covers the same pages.

## Revisit when

- eBay contacts Intra AI about the app, keyset or buying account, or warns, limits or disables the keyset.
- The agreement footer date is no longer "Sept 3, 2025" or the clauses on amendment or deletion change.
- eBay states that Browse is a Restricted API.
- Anyone outside Intra AI uses the tool, or eBay data would be shared outside Intra AI.
- A seller or user complains about the data.
- On revocation: stop polling, delete eBay content within 10 days, choose F2 or stop (ADR 0004).
