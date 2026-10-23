# ADR-0038: Sign-in with email codes for approved people

**Date**: 2026-10-22
**Status**: proposed
**Deciders**: Simon Klimaszyk (D-01)
**Related**: supersedes ADR 0021 once accepted; amends ADR 0012, 0014, 0035; ADR 0002, 0005, 0007, 0011, 0013, 0029, 0037, 0039; D-01, D-37, D-48

## Context

- v2 puts the admin UI on the internet at `https://deals.intra-ai.de` (ADR 0039). Today the only page beyond the public paths is the MVP dashboard on `127.0.0.1:3142`, reached over SSH.
- ADR 0021 chose Better Auth's email OTP plugin with SES. Its docs show unkeyed SHA-256 code storage (`hashed`), eight mounted routes, codes not bound to the asking browser, and an IP-and-path limiter only (Better Auth email OTP plugin docs; notes `auth.md` section 2). Most of ADR 0021's hard parts were our own code around the library anyway.
- Hono 4.13.13 (pinned) already gives `hono/cookie` (refuses a `__Host-` cookie without Secure and Path=/), `hono/csrf` and `hono/secure-headers`.
- NIST SP 800-63B-4 section 3.1.3.1 says email shall not be used for out-of-band authentication; OWASP ASVS 5.0 6.3.6 (level 3) agrees. An email code is as strong as the mailbox. The owner chose it for a small internal tool.
- The eBay deletion endpoint, `/healthz` and `/privacy` must stay public and unchanged (ADR 0013).
- Owner decisions for the v2 spec, section 12 (2026-10-22): 2 sign-in and security mail from a separate mailbox `noreply@intra-ai.de` (`LOGIN_SMTP_*` all or none); `web` never holds the `info@` password. 3 one admin for now, `AUTH_BOOTSTRAP_ADMINS=info@intra-ai.de`; recovery through `ops auth code --ref`. 4 24 h idle, 7 days absolute, 15-minute step-up, device cookie 180 days. 5 roles admin and editor.

## Decision

We sign people in with an 8-digit code sent by email to approved addresses only, through our own small auth module in a new `web` service (Hono, `node:crypto`, Postgres, no new dependency), with server-side sessions, two roles (admin and editor), and a device cookie so a stranger cannot lock the owner out. `server` keeps the deletion endpoint, `/healthz` and `/privacy`, and never reflects request input as HTML.

### Services and routes (amends ADR 0012)

- New Compose service `web` (same image, `apps/web`) on `127.0.0.1:3141`, with its own `/healthz` reached only from the host. `server` stays on `127.0.0.1:3140`. Port 3142 and the MVP dashboard go.
- Traefik: the existing router for `/healthz`, `/privacy` and `/ebay/account-deletion` gets `priority: 100` and is otherwise unchanged; `POST /login*` gets its own router (priority 50) with a rate limit of 10 a minute, burst 5; everything else on the host goes to `web` (priority 10) with 20 a second, burst 100. Both new routers use the 64 KB body limit (spec 7.10).
- Public on `web`: `GET/POST /login`, `GET/POST /login/code`, `GET /assets/*`. Everything else needs a session (GET 303 to `/login`, other methods 401); admin routes give editors 403.

### Codes and sessions

- 8 random digits from `crypto.randomInt`, valid 10 minutes, single use, bound to a `__Host-jbi_login` cookie, 3 tries per code, at most 3 live codes per address. Stored as `HMAC-SHA-256(K_code, attempt_id || code)`, compared with `timingSafeEqual`. `AUTH_KEY` (32 bytes, base64) is in `.env` and passed to `web` only; subkeys by HKDF.
- One check takes the rate slot and the try each in one atomic statement before comparing, and creates the session in one statement joined to `auth.app_user WHERE status = 'active'` (spec 7.3).
- Every address gets the same reply, status and steps; the mail is queued after the reply, only for active addresses within caps. The code page shows a 4-character reference.
- Sessions: 32 random bytes, stored as SHA-256, cookie `__Host-jbi_session` (Secure, HttpOnly, SameSite=Lax). 24 h idle, 7 days absolute, never extended (owner decision 4). Automatic refreshes never move `last_seen_at`. New token on every sign-in; all sessions of a person end on role change or disable; at most 10 per person.
- Step-up: adding, disabling, re-roling a person and ending someone else's sessions need a sign-in in the last 15 minutes (owner decision 4).
- Device cookie `__Host-jbi_device`, 180 days (owner decision 4, OWASP device cookie pattern). A request with a valid device cookie for the address it names uses per-device counters and skips the address cap, the lockout and the global mail cap.
- Limits as in spec 7.5, among them 5 code requests per IP per 15 minutes, 5 codes per address per hour and 10 per Berlin day, 10 failed tries per address per 24 h, 60 sign-in mails a day without a device cookie. The IP is the last `X-Forwarded-For` entry and is used only for limits and the sign-in record.
- CSRF: synchronizer token per session, plus `Sec-Fetch-Site: same-origin` or `Origin` exactly `PUBLIC_ORIGIN` on every non-GET request; SameSite=Lax; no CORS headers; GET never changes state.

### People and roles

- `auth.app_user` with role `admin` or `editor` (owner decision 5). Editors manage products, check market values and choose alert recipients; admins also change settings, manage people and read the Activity page. No read-only role.
- The last active admin cannot be demoted or disabled (`SELECT ... FOR UPDATE` on active admins). Disable, in one transaction: status `disabled`, sessions ended, devices revoked, open login attempts closed.
- Bootstrap: `ops migrate` adds each address of `AUTH_BOOTSTRAP_ADMINS` as active admin only when no active admin exists. v2 starts with one admin, `AUTH_BOOTSTRAP_ADMINS=info@intra-ai.de` (owner decision 3).
- Recovery: `ops auth code <email> --ref <ref>` over SSH finds the open attempt with that reference from the last 10 minutes, prints its time, IP and user agent, asks for confirmation, prints the code and audits the reference. Without `--ref` it refuses. `ops auth` also lists, adds, disables and unlocks people, audited as `system:cli`.

### Mail (amends ADR 0035)

- Sign-in and security mail is sent by `web` through nodemailer (`packages/notify`) from the separate mailbox `noreply@intra-ai.de`, configured by `LOGIN_SMTP_HOST`, `LOGIN_SMTP_PORT`, `LOGIN_SMTP_USER`, `LOGIN_SMTP_PASSWORD` and `LOGIN_FROM`, all or none (owner decision 2). `web` never gets `SMTP_PASSWORD`, the `info@intra-ai.de` password of ADR 0035, which stays with the worker for alert mail. With none set, only `ops auth code` signs people in.
- Security mail to all active admins (and the person concerned) on `user.added`, `user.role_changed`, `user.disabled`, `bootstrap.admin_added`, `login_code_cli`, a recipients change that adds another person, and a sign-in from a browser without a device cookie; at most 30 a Berlin day.
- The code, token, cookie, full address, `AUTH_KEY` and `LOGIN_SMTP_PASSWORD` are never logged; they join the redaction list and the sentinel test.

### Data (amends ADR 0014)

| Table (schema `auth`) | Class and lifetime |
|---|---|
| `app_user` | Kept while the person exists; never deleted by `web` |
| `login_attempt` | Purged after 24 h |
| `session` | Ended rows purged after 30 days |
| `device` | Purged 30 days after revoke or 180 days unused |
| `rate_counter` | Purged after 2 days |
| `auth_event` | Kept 90 days (IP addresses for rate limits and security) |

Role `web` has no DELETE on any `auth` table; the worker purges them. Strangers' addresses are stored only as HMAC. `/privacy` gets one paragraph on sign-in data.

### Output safety

- Every `web` response carries the CSP of spec 7.11 (`default-src 'none'; script-src 'self'; style-src 'self'; ...; frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and the rest of that list.
- `server` never reflects request input as HTML. `/privacy` has a strict CSP and nosniff since Release 0; the deletion route stays untouched.

## Alternatives considered

- **Better Auth email OTP (ADR 0021)**: maintained library, but unkeyed code hashes, extra routes to block, no browser binding and no per-address caps; we would still write most of the logic.
- **Passkeys (WebAuthn)**: stronger and removes the mailbox as single point, but more to build and a fallback is still needed. Later, for admins first.
- **Magic links**: mail scanners open links and use them up; a link is easier to phish than a code bound to the asking browser.
- **Keep the UI on 127.0.0.1 behind SSH**: no login to build, but editors without SSH access cannot use it.
- **`web` sends with the `info@` mailbox**: one mailbox fewer, but the internet-facing service would hold the password that also sends alerts. Not taken (owner decision 2).
- **A second admin from day one** (spec default): protects against losing the one mailbox, but the owner wants one admin for now; `ops auth code --ref` over SSH is the recovery path (owner decision 3).

## Consequences

**Positive**
- Approved people can use the platform from any browser; strangers learn nothing about which addresses are approved.
- No new dependency; every security control has a test.
- A stolen database backup gives no usable code or session.
- A stranger can block new browsers for an address for a day, but not a browser with a device cookie, and never `ops auth code`.

**Negative**
- An email code is only as strong as the mailbox (NIST and ASVS above); mailbox MFA is a policy we cannot enforce.
- Our own auth code has no outside review: the fresh-context review and the tests are the control.
- One more long-running service: 192 MB of memory, 4 database connections.
- One admin: if `info@intra-ai.de` is lost, recovery needs SSH to the host.

**Risks**
- Traefik's handling of a forged `X-Forwarded-For` is documented only in its forum. Mitigation: the host proxy test (spec 11.6) before the route goes live; per-address and global caps do not depend on the IP.
- A hijacked admin session raises spend. Mitigation: `.env` ceilings on every reservation (ADR 0037), step-up for people changes, security mail on each change.
- A disabled person keeps an open code. Mitigation: disable closes attempts in the same transaction; the session insert joins on `status = 'active'`; test.
- The mail provider's sending limit is unknown. Mitigation: caps keep sign-in mail at 60 a day plus 30 security mails; Simon checks the limit before the deploy.

## How we check it

- `apps/web` tests against Postgres 18 and a fake SMTP transport: the tests of `auth.md` section 15; same reply for unknown, disabled and active addresses while SMTP hangs; the three lockout tests of spec 7.5; auto requests do not move `last_seen_at`; `__Host-` cookies only; CSRF refusals; headers on every response; security mail on each event; sentinel test for secrets in logs.
- A route-group test walks every route and asserts `public`, `session` or `admin`.
- `auth-store` tests: 50 parallel wrong guesses give exactly 3 comparisons; two parallel right guesses give one session; disable ends sessions, revokes devices and closes attempts in one transaction; two parallel disables of the last two admins leave one.
- `grants.test.ts`: `web` cannot DELETE from any `auth` table, cannot touch `pgboss` or the deletion tables.
- `ops auth code` refuses without `--ref` and audits the reference.
- `ebay-deploy` refuses a partial `LOGIN_SMTP_*` set (ADR 0029, v2 amendment); smoke checks `/login` for the CSP and `X-Frame-Options: DENY`.
- The deletion route test stays unchanged and green.

## Revisit when

- More than about 10 people, or anyone outside Intra AI.
- Passkeys for admins are wanted, or an identity provider (Google Workspace or similar) exists.
- A second admin is added, or a cap trips more than once a month.
- IPv6 clients reach the site.
