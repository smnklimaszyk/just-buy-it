# eBay API access: deletion subscription, gate 1a, call limits

Status 2026-10-19. Owner: Simon Klimaszyk (D-01). Accounts held by Intra AI (D-02). Vendor facts read 2026-10-19; **unverified** marks what eBay's pages do not state.

## What is left to do

| Step | State |
|---|---|
| Developer Program account, application with sandbox and production keysets | Done |
| Support activated (needed before any ticket or Growth Check) | Not confirmed |
| Account deletion subscription in the production keyset (activates it) | Endpoint being deployed (Phase 0 S3) |
| Gate 1a: one live EBAY_DE search returns EUR | After activation (Phase 0 S5) |
| Application Growth Check | Only if 5,000 Browse calls a day are not enough (D-57) |

Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## Keysets (done)

- App ID, Dev ID and Cert ID per environment are in the password manager.
- Production App ID and Cert ID become `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` in `/opt/ebay-sniper/.env` ([environments](../environments-and-secrets.md)). Production App ID also goes in `docs/compliance/gates.md`.
- Never paste the Cert ID into a ticket, email or form.
- Auth: client credentials at `https://api.ebay.com/identity/v1/oauth2/token`, scope `https://api.ebay.com/oauth/api_scope` (covers `search`, `getItem`), token 7,200 s, no user token ([authorization guide](https://developer.ebay.com/develop/guides-v2/authorization.md)).

## Deletion subscription (production keyset)

Source: [marketplace account deletion](https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion). eBay: "Before you can use your Production keyset, you must subscribe to or opt out of" these notifications. Do not opt out. Design: [ADR 0013](../../adr/0013-ebay-user-data-deletion-and-identifiers.md), [Phase 0 section 6](../phases/phase-0.md).

### Before you start

Saving in the portal triggers eBay's challenge at once, so the endpoint must be live:

1. `dig +short deals.intra-ai.de` gives the server's IP and Traefik serves a valid Let's Encrypt certificate.
2. `/opt/ebay-sniper/.env` (root, 0600, copy in the password manager) holds:
   - `EBAY_DELETION_ENDPOINT_URL=https://deals.intra-ai.de/ebay/account-deletion`: byte for byte what goes into the portal, no trailing slash, no query string.
   - `EBAY_DELETION_VERIFICATION_TOKEN`: 32 to 80 characters from `[A-Za-z0-9_-]`, generated with `openssl rand -hex 32`.
3. The endpoint answers GET (challenge) and POST (notifications); eBay requires both.
4. Challenge check from your laptop. Both lines must print the same hex:

```sh
TOKEN='<token from the password manager>'
curl -si 'https://deals.intra-ai.de/ebay/account-deletion?challenge_code=abc123'
printf '%s' "abc123${TOKEN}https://deals.intra-ai.de/ebay/account-deletion" | shasum -a 256
```

Expect HTTP 200, `Content-Type: application/json`, body `{"challengeResponse":"<hex>"}`. eBay hashes `challengeCode + verificationToken + endpoint` in that order, SHA-256, hex (`sha256sum` on the server). A spoofed `Host` header must not change the hash (Phase 0 A1). `curl -si -X POST -H 'Content-Type: application/json' -d '{}' <endpoint>` returns 204.

### Steps in the portal

1. Sign in, open [Application Keys](https://developer.ebay.com/my/keys), select **Notifications** next to the **production** App ID. This opens **Alerts and Notifications** (`/my/push`).
2. Under **Event Notification Delivery Method**, select **Marketplace Account Deletion**.
3. **Alert email**: Simon's `intra-ai.de` mailbox (D-48), used only for endpoint warnings. Select **Save** next to it.
4. **Notification Endpoint**: `https://deals.intra-ai.de/ebay/account-deletion`.
5. **Verification token**: paste the token, select **Save**. eBay sends the GET challenge now. If it fails, nothing is saved: compare the URL with `EBAY_DELETION_ENDPOINT_URL` and check the server log.
6. Select **Send Test Notification**. The server log shows the POST, a 204, and the verification result (`app.deletion_event` row if verified, otherwise the hourly counter).
7. In **Application Keys**, "Your Keyset is currently disabled" is gone. Activation time is **unverified**.
8. Record in `docs/compliance/gates.md`: date, endpoint URL, keyset status, a portal screenshot without the token (Phase 0 A6).

### What eBay expects afterwards

- Acknowledge every notification with 200, 201, 202 or 204. Unacknowledged ones are resent; after 24 h the endpoint is marked down and the alert address is emailed; then 30 days to fix before non-compliance, which can end Developer Tools access.
- Up to 1,500 notifications a day (eBay's deletion page, cited in ADR 0013). `getPublicKey` has its own pool of 10,000 a day.
- An external probe (UptimeRobot, 5 min) watches the endpoint on the shared host.
- On stop: retire the keyset before shutting the endpoint down.

## Gate 1a: one live EBAY_DE search

**Passes when** one `item_summary/search` on `EBAY_DE` with the production keyset returns EUR prices, after the keyset is active. A sandbox result does not count. Evidence in `gates.md`: request ID, timestamp, HTTP status, `total`, currencies. No listing content (Phase 0 A16).

**Run it** on the server in `/opt/ebay-sniper`, once the contract CLI exists (Phase 0 S5):

```sh
docker compose run --rm worker contract:run --shapes Q1
```

The CLI reads `getRateLimits`, reserves every Browse call (purpose `contract`), writes metadata only to `/var/lib/ebay-sniper/contract/`. Caps per [Phase 0 section 8](../phases/phase-0.md) (A19) and [ADR 0011](../../adr/0011-environments-accounts-and-secrets.md): no start below 1,500 remaining calls, stop after 100 calls per run. Do not send the request below by hand; it bypasses the call counter.

```sh
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-EBAY-C-MARKETPLACE-ID: EBAY_DE" \
  "https://api.ebay.com/buy/browse/v1/item_summary/search?q=rtx%203090&limit=3&filter=priceCurrency:EUR,deliveryCountry:DE"
```

Host and path: Browse OpenAPI v1.20.4. The request ID header name is **unverified**; record it from the first response in `docs/ebay/contract-results.md`.

**If 1a fails** (keyset inactive, errors, no EUR): Simon decides stop or wait within 2 business days (Phase 0 risks). Fallback F2: eBay saved-search emails, or stop (D-07).

## Call limits

Source: [API call limits](https://developer.ebay.com/develop/api/buy/api_call_limits).

| API | Default limit |
|---|---|
| Browse, all methods except getItems (`search` and `getItem` share this pool) | 5,000 a day |
| Browse getItems (bulk, "Limited Release", scope `buy.item.bulk`) | 5,000 a day, separate |
| Notification (`getPublicKey`) | 10,000 a day |

Footnote "Buy APIs require an additional license": licence review is the operator's responsibility; out of scope for this repo. Version 1 is planned inside the default pool ([ADR 0016](../../adr/0016-ebay-ingestion-feeds-and-call-budget.md)): every Browse call is reserved in Postgres and the feed editor refuses plans above 80%. Retries: eBay's Growth Check checklist allows "retries for a maximum of two times for infrastructure errors"; our client retries a 5xx or timeout once on GET and never retries 429 (Phase 0 A20).

## Application Growth Check

Sources: [Growth Check](https://www.edp.ebay.com/grow/application-growth-check), [Get Started guide](https://developer.ebay.com/develop/guides/get-started-with-ebay-apis.md).

- Free. Needed to raise call limits, use getItems or get more keysets. No review time published.
- **Default (D-57): do not file.** If more than 5,000 a day is needed, Simon decides. Answers must be truthful.
- The checklist bans, among others, statistics on "types of eBay users", "average selling price ... for any eBay category" and "statistical data about eBay".

If filed:

1. Activate support first (eBay requires it before a Growth Check or any ticket): **Profile & Contacts**, complete **Primary Contact**, then **Edit** > **Activate Support**.
2. Note per checklist item in `docs/compliance/growth-check.md`.
3. Open the **Application Growth Check** tab: `https://developer.ebay.com/my/support/tickets?tab=app-check`.
4. Per call: peak, hourly and daily volume from `api_usage_hourly`, and the API version.
5. Fill all red-asterisk fields, **Submit**. Record both sides in `docs/compliance/`.

## Checklist

- [ ] DNS, certificate, `.env` values live; challenge and POST checks pass
- [ ] Portal: alert email, endpoint, token saved; test notification logged
- [ ] Keyset active; date and screenshot in `gates.md`; probe running
- [ ] Gate 1a evidence in `gates.md`, no listing content
- [ ] Support activation confirmed by Simon
- [ ] Growth Check only by Simon's decision (D-57)
