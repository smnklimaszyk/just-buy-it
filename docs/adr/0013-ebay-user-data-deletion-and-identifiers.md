# ADR-0013: Account deletion endpoint, seller data and item identifiers

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0007, 0014, 0016, 0018, 0023, 0024

## Context

- The production keyset activates once the deletion subscription is saved. Opt-out is only for apps "not persisting any eBay data"; we store listings ([eBay](https://developer.ebay.com/marketplace-account-deletion), 2026-10-19).
- Challenge: `GET ?challenge_code=`, reply 200, `Content-Type: application/json`, `{"challengeResponse": hex(SHA-256(code + token + endpoint))}`. Token 32-80 chars `[A-Za-z0-9_-]`. HTTPS only, no localhost or internal IP.
- Notifications: POST, acknowledge at once (200-204), then verify via `x-ebay-signature` and getPublicKey. 24 h unacknowledged marks the URL down; 30 days later the app is non-compliant. Up to 1,500 a day.
- getPublicKey: same keyset, `api_scope` only, Notification limit 10,000 a day (not Browse).
- 8.2.1.3: never "collect, store or share" eBay User IDs.
- Browse item IDs: `v1|<legacy>|<variation>`, `0` for no variations.

## Decision

Acknowledge first, verify later, store no seller identity. Primary keys are `uuidv7()`.

| Part | Rule |
|---|---|
| Config | `EBAY_DELETION_ENDPOINT_URL` is `https://deals.intra-ai.de/ebay/account-deletion` exactly, no trailing slash. Token is 64 chars. The challenge never reads `Host` or `X-Forwarded-*`. |
| Route | GET and POST only, before session, CSRF and rate-limit middleware. Traefik `buffering` and Hono `bodyLimit` cap bodies at 64 KB. Larger gets 413, other methods 405, never 400. |
| Queue | At most 1,000 pending; overflow POSTs still get 204, counted `dropped`. Shutdown waits up to 10 s; the rest counts as `dropped_on_shutdown`. |
| Key fetch | Key IDs over 128 printable ASCII chars are `malformed`. Keys cache 1 h; rejected IDs 1 h (LRU of 10,000). One fetch at a time, at most 10 unknown-key fetches per hour (else `key_fetch_limited`): about 240 a day. Logged in `api_usage_hourly` as `deletion-key`, never reserved (ADR 0007). |
| Audit | `app.deletion_event`: one row per verified notification_id, 1 year, no username, userId, eiasToken or body. A repeat sets `publish_attempt_count` to the larger value. Other results (incl. `unsupported_alg`) are counted in `app.deletion_result_hourly`, 90 days. With Postgres down, a verified event becomes a pino line. pino redacts user fields. |
| Deletion | Nothing is keyed by eBay user; listings are purged within 6 h (ADR 0014). Nothing to delete. |
| Seller | Browse schemas drop `seller.username` and `sellerLegalInfo`. Account type and feedback may sit on the listing row and drive rules. Same-seller signal and per-seller cap stay off. No seller identifier to Claude (ADR 0018). |
| Item key | `item_key = HMAC-SHA256(ITEM_KEY_Vn, canonical ID)` with `key_version`. Canonical ID is `<legacy>` for variation `0`, else `<legacy>:<variation>`; a week-one fixture confirms it (D-16). Item groups are excluded from samples and alerts (ADR 0016). `ITEM_KEY_V1`: 32 random bytes in env file and password manager, not in dumps. Rotate only on a leak; keep V1 for 180 days. |

## Alternatives considered

Rejected: opt-out (false declaration), verify-first with 412 (outages trip the 24 h rule), 400 for bad bodies, an audit row per POST, a seller HMAC, raw or unkeyed item IDs.

## Consequences

**Positive**: works without Postgres or getPublicKey; load stays bounded; no seller identity stored.

**Negative**: the server holds the eBay secret; a crash or flood can lose a genuine row (still acknowledged); no same-seller signal; one more secret.

**Risks**
- eBay may revoke the keyset or suspend accounts. Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.
- Flood: limits above; ops email to Simon above 1,000 non-verified results an hour or after 6 h of only `key_unavailable`.
- eBay changes the signature format or schema version: POSTs are still acknowledged, any `schemaVersion` is accepted, unknown algorithms count as `unsupported_alg`, Ops shows non-zero counts.
- Env and portal drift, host load, Traefik changes: deploy env before saving in the portal; external probe every 5 min (ADR 0030).
- No second person: merge after CI checks and a fresh-context review by a separate agent; production deploys need Simon's go (convention, no branch protection).

## How we check it

- Challenge hash equals `printf '%s' "$code$token$url" | shasum -a 256`, whatever the headers.
- Postgres stopped, getPublicKey timing out: 204 before any fetch; no user fields in logs.
- 1,000 POSTs with random key IDs: all 204, at most 10 fetches, 0 rows, counters sum to 1,000; a repeat makes no new fetch.
- 5,000 POSTs, hanging fetch: queue at most 1,000. One notification 100 times: one row. 65 KB body: 413. 1,500 signed POSTs: all 204, 1,500 rows.
- Non-JSON and unknown-shape bodies: 204, counted `malformed`, no body text in logs. Same item in two feeds: one item_key; the variation fixture gives the agreed ID.
- Signature test: local ECDSA key, aligned with eBay's real header once seen.
- Schema test: no `username`, `eias` or `ebay_user*` columns; `seller_*` allowlisted; `user_id` references auth users; `item_key` has `key_version`.
- Sentinel test (ADR 0023): no username in logs or fixtures.
- dependency-cruiser: the deletion route imports only the token and public-key modules.
- Ops: verified notifications per day, results by status per hour.
- Live: subscription saved, keyset active, noted in `docs/compliance/gates.md`.

## Revisit when

- eBay changes the deletion page, schema, getPublicKey or licence footer ("Sept 3, 2025").
- The fixture contradicts the canonical ID; the item key leaks; genuine notifications end as `key_fetch_limited` or `dropped`.
- The app stores eBay user data; then verify before deleting.
