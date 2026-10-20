# ADR-0002: A person completes every purchase

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0001, 0003, 0004, 0006, 0011, 0022, 0032; D-01, D-04, D-07, D-08; [company vs private](../planning/guides/company-vs-private.md)

## Context

- The tool finds cheap used hardware on eBay.de, checks price and scam risk, and alerts Simon. This record is gate 3.
- eBay's User Agreement (section 3, version effective 28 June 2026) forbids "buy-for-me agents, LLM-driven bots, or any end-to-end flow that attempts to place orders without human review", plus robots and scrapers, without prior express permission. Source: https://www.ebay.com/help/policies/member-behaviour-policies/user-agreement?id=4259. The German AGB is not yet read; this decision is the conservative option under either text.
- The Offer API (bids) and Order API (checkout) are Limited Release APIs for select approved developers, and both need a user OAuth token for a buyer account (Offer scope `buy.offer.auction`). Sources: https://developer.ebay.com/api-docs/buy/offer/static/overview.html, https://developer.ebay.com/api-docs/buy/order/static/overview.html.
- eBay.de's automatic bidding places "ein bindendes Gebot" up to the buyer's maximum. Source: https://www.ebay.de/help/buying/auctions-bidding/automatisches-bietsystem?id=4014.
- Screening cannot detect a swapped die, a gutted card or an AI-generated photo, so a person must judge each purchase anyway.
- "Sniping" in the project name means finding deals, not last-second automated bidding.

## Decision

The tool finds, checks and links listings; a person always buys through eBay checkout or bids by entering a maximum in eBay's own automatic bidding, for both buyer profiles (company account or Simon's private account). We do not use the Offer or Order API, do not bid or buy automatically, use no scraping or browser automation against eBay, and store no eBay buyer credentials or user OAuth tokens.

## Alternatives considered

- **Auto-buy for the top tier**: a wrong tier or missed scam costs real money at once; Order API not available to us; banned without human review.
- **Offer API last-second bids**: Limited Release, needs a stored buyer token, every bid binds the buyer so a bug creates a debt.
- **Third-party sniping service with our credentials**: an outside party holds our buyer login; automated access risks account suspension.
- **Browser automation for bids or orders**: exactly the banned "robot"; breaks on page changes and captchas; needs stored credentials.

## Consequences

**Positive**
- No buyer credentials exist in the system, so a server compromise cannot spend money. The secrets register (ADR 0011) has no eBay user entry.
- The eBay client needs only the client-credentials application token.
- Each purchase passes a person with the arrival checklist and the 30-day Money Back Guarantee deadline in view.

**Negative**
- Some deals sell before anyone acts, especially at night. We measure the share of alerts still available after 30 minutes.
- Auction maximums entered early give up any last-second timing advantage (effect not measured).

**Risks**
- Scope drift (a "Buy now" call or auto-bid added later): caught by the checks below; any change needs a new ADR (ADR 0001).
- Someone connects a sniping service to the alerts: the purchasing rule under D-04 says bids and orders are placed by hand only.
- A suggested maximum bid in an email (ADR 0032) is allowed; a person still types it into eBay.

## How we check it

CI on every pull request:

| Check | Fails when |
|---|---|
| Endpoint allowlist in `packages/ebay` | All eBay requests go through one request function that rejects any method, host or path off the allowlist before sending. Allowlist: OAuth token (`client_credentials`, scope `https://api.ebay.com/oauth/api_scope`), Browse search and getItem, Analytics getRateLimits, Notification getPublicKey, read-only Taxonomy/Metadata, `GET` on the Browse image host (exact Analytics, Notification, Taxonomy and image paths come from the pinned OpenAPI files). A unit test asserts the exact list and that `/buy/order/` or `/buy/offer/` throws without a network call |
| No other HTTP path | ESLint finds `fetch`, `node:http(s)` or `undici` outside `packages/ebay`; an Offer or Order schema appears; MSW sees an unhandled request (`onUnhandledRequest: 'error'`) |
| Env schema | A key matches `/(EBAY_(USER\|PASS\|REFRESH)\|refresh_token)/i` |
| Runtime image | `pnpm ls --prod` for server and worker lists `playwright`, `puppeteer`, `selenium-webdriver` or `chromium`, or the built image contains a Chromium/Playwright binary; a dependency-cruiser rule (ADR 0006) finds these packages imported outside the `apps/web` e2e folder |
| Email links | Any eBay link is not `https://www.ebay.de/itm/<legacy id>` with no query or fragment; a feedback link does not go to the dashboard origin (`https://deals.intra-ai.de`) and open a page, or acts on eBay |
| README | The first paragraph lacks the sentence defining "sniping" as finding deals |
| String scan | `apps/` or `packages/` contain `/buy/order/`, `/buy/offer/`, `checkout_session`, `authorization_code` or another eBay OAuth scope (backup only) |

A change to the allowlist merges only after CI and the fresh-context Claude Code review (D-37); Simon reads that diff against this record. The PR template asks "Does this change act on eBay on a user's behalf?"; a yes needs a new ADR.

## Revisit when

- eBay gives written permission for automated ordering or bidding.
- eBay changes the User Agreement clause on bots and automated orders.
- The share of No-brainer alerts still available after 30 minutes falls below the D-08 target at the 28-day review (D-07, ADR 0004). Even then, this ADR changes only with eBay's permission.
