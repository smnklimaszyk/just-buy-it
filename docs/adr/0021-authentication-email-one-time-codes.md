# ADR-0021: Dashboard login with email one-time codes

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0007, 0009, 0011, 0012, 0022, 0023, 0024, 0029; D-01, D-03, D-19, D-24, D-37, D-48

## Context

- Users: Simon now, a few colleagues later. Dashboard and API share `https://deals.intra-ai.de` (ADR 0007), so no CORS.
- Better Auth 1.7.11 email OTP defaults to 6 digits, 300 s, 3 attempts, but stores codes in plain text and allows sign-up ([docs](https://www.better-auth.com/docs/plugins/email-otp)); `hashed` is unkeyed SHA-256. With `disableSignUp`, an unknown email gets `{ success: true }` and no mail. Each resend replaces the old code. Account routes (password reset, delete user) are mounted too. The send callback is awaited unless `backgroundTasks.handler` is set.
- Limiter: in memory by default, keys on `ip|path` from `X-Forwarded-For`, no per-email cap ([docs](https://www.better-auth.com/docs/concepts/rate-limit)). Host-network Traefik sees the real peer; server on `127.0.0.1:3140` (ADR 0012).
- Login mail shares SES sender and quota with alerts. Sandbox: 200 mails a day, verified recipients only ([AWS](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)).

## Decision

Email one-time codes are the only sign-in method; codes go straight to SES.

| Item | Setting |
|---|---|
| Codes | `storeOTP: 'hashed'`, `disableSignUp: true`, 6 digits, 300 s, 3 attempts |
| Routes | Allowlist (not `disabledPaths`): `POST /email-otp/send-verification-otp`, `POST /sign-in/email-otp`, `GET /get-session`, `POST /sign-out`; others 404 |
| Per-IP limits | send 3, sign-in 5 per 600 s; database storage; on everywhere |
| Mail caps | 10 per user per hour, 40 per UTC day (settings, ADR 0009); atomic `INSERT ... ON CONFLICT ... WHERE used < max` in `app.login_code_quota` |
| Send | Only `type: 'sign-in'`, as a tracked background task; SIGTERM waits up to 5 s. Wrong type: log `login_code_wrong_type`. Capped: log `login_code_capped` with user, cap, address. SES timeout 5 s; code never logged; no link |
| Proxy | `trustedProxies` empty: limiter uses the single `X-Forwarded-For` entry Traefik writes. IPv4 only in version 1 (A record, no AAAA) by choice: address handling is verified only for IPv4. Missing or internal addresses count as `auth_ip_internal` |
| Sessions | 7 days, rolling daily; `createdAt` over 30 days: rejected and deleted |
| Cookies, CSRF | Secure, HttpOnly, SameSite=Lax; one `trustedOrigins` entry; state changes JSON POST only (else 415) plus `hono/csrf`; no CORS headers |
| CLI | `user:add` (sandbox: verify the address in SES first), `user:remove` (deletes sessions), audited; break-glass `login-code <email>` over SSH prints a code, audited, outside the caps |

## Alternatives considered

- **Magic links**: mail scanners use them up; our mail links never change state (ADR 0022).
- **Auth.js**: link-based, no attempt counter or limiter.
- **Tailscale**: client per device, paid plan, public paths remain.
- **Passkeys only**: still need recovery; later.
- **Google Workspace SSO**: not confirmed; would replace codes.
- **Per-IP limit only**: many IPs could drain the SES quota alerts need.

## Consequences

**Positive**: no user enumeration or mail to strangers; at most 40 login mails a day, leaving 160 sandbox mails for alerts.

**Negative**: an outsider knowing an address can block that user's codes for an hour and all new logins for the day (sessions and CLI still work); a reader of `auth.verification` can recover a code; every login needs SES; only the newest code works; allowlist, caps and session limit are our code.

**Risks**
- Login lockout. Mitigation: 7-day sessions; ops mail on a cap trip (at most hourly, outside the login caps, to Simon, D-48); block the logged address in Traefik; `login-code`; raise the cap with SES production access (D-19). Steps: "Login lockout" runbook.
- Code guessing. Mitigation: 3 attempts per code; the 40-per-day cap allows at most 120 guesses a day against 1,000,000 values; the cap ops mail makes a sustained attack visible.
- Forged client address: any process on the shared host can reach `127.0.0.1:3140`. Mitigation: proxy test, `auth_ip_internal` ops mail, post-deploy check.
- Removed user keeps a live session. Mitigation: `user:remove` deletes sessions in the same transaction; none outlives 30 days.
- A Better Auth upgrade changes routes or defaults. Mitigation: pinned versions (ADR 0005), allowlist, tests.

## How we check it

- Unit test: config above, four routes, no `Access-Control-Allow-Origin`.
- Integration (Postgres 18, MSW-mocked SES): unknown email: same 200, no mail; send returns 200 while the callback hangs; blocked routes 404; wrong type reserves nothing; 4th wrong code `TOO_MANY_ATTEMPTS`; per-IP 429; 11th mail per user and 41st per day refused, one ops mail; 31-day session 401, 29-day works; code never stored or logged.
- Proxy test behind Traefik: limiter key equals the client address despite a forged header; a direct request to the server port from outside fails.
- Post-deploy check (ADR 0029, after Simon's go): send for a reserved unknown address; `auth_client_ip` must be `public`.
- CSRF: cross-origin form and `text/plain` POSTs rejected; JSON POST without session 401.
- Playwright login flow (ADR 0023). Ops page (ADR 0024): login mails per day, `login_code_capped`, `login_code_wrong_type`, `auth_ip_internal`, SES rejections.
- Auth changes merge only after CI checks, a fresh-context Claude Code review and Simon reading the diff, by convention (D-37). A new auth route or setting amends this ADR.

## Revisit when

- Google Workspace exists, users exceed about 10, or outsiders need access.
- SES production access is decided, or a cap trips more than once a month.
- Any Better Auth minor or major upgrade.
- IPv6 clients (testable behind host-network Traefik; repeat proxy and post-deploy checks), a second origin or API host.
- Database read access widens (use a keyed hash), or Simon wants passkeys.
