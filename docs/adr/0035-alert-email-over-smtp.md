# ADR-0035: Alert email over SMTP for the MVP

**Date**: 2026-10-21
**Status**: proposed
**Deciders**: Simon Klimaszyk (D-01)
**Related**: ADR 0006, 0011, 0014, 0015, 0022, 0024; D-48
**Amends**: ADR 0022 (MVP only: alert email does not go through SES); ADR 0006 (the `notify` adapter is SMTP)

## Context

- The MVP sends one alert email per candidate to one address, `info@intra-ai.de` (MVP spec, section 6). Volume is capped in code at 10 emails per rolling hour and 60 per Berlin day.
- ADR 0022 plans Amazon SES in eu-central-1 with its own identity `alerts.intra-ai.de`, DKIM, a MAIL FROM domain, an IAM key and a production-access request. None of it is set up yet, and the sandbox only sends to verified identities.
- The company mailbox `info@intra-ai.de` already exists on `mail.intra-ai.de`, which accepts authenticated submission on port 587 with STARTTLS.
- On 2026-10-21 the owner decided that the MVP sends alerts from that mailbox over SMTP, and configured the values on the host (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `ALERT_FROM=Just-Buy-It <info@intra-ai.de>`, `ALERT_TO`).
- nodemailer 10.1.1 (published 2026-10-14) has no dependencies, ships its own types, is MIT-0 licensed and has no install script.

## Decision

For the MVP, the worker sends alert email over SMTP with nodemailer from the existing mailbox `info@intra-ai.de` on `mail.intra-ai.de:587` with STARTTLS required. The SMTP password is a secret in `/opt/ebay-sniper/.env` only. SES stays the target for login codes (Phase 1 S3) and is reconsidered for alert mail then.

| Part | Rule |
|---|---|
| Code | Only `packages/notify` imports nodemailer (dependency-cruiser rule `nodemailer-only-in-notify`). `packages/notify/src/smtp.ts`: `secure` only on port 465, `requireTLS` on every other port, connection and greeting timeouts 10 s, socket timeout 20 s, no pooling, one message per delivery with the header `X-Delivery-Id` |
| Sender | `ALERT_FROM` is a bare address or a display name with the address. `parseSender` returns `{ name, address }` and nodemailer encodes the name. CR, LF, `<` or `>` in the name, an empty address or a second address stop the worker at startup |
| Configuration | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `ALERT_FROM`: all five or none. A partial set stops the worker and `ebay-deploy`, naming only the missing variables. With none set the worker runs and alerts stay `pending` with hold reason `smtp_not_configured` |
| Errors | A 250 reply is `sent`. A 4xx reply, a refused connection, a timeout or a TLS error is retried by relay (1, 5, 15, 30 minutes, at most 5 real attempts). Another 5xx is `failed`. `EAUTH` (535) pauses all sends for 15 minutes (`app.smtp_pause`). The adapter keeps only `{ code, responseCode }` and drops the original error, whose fields can carry the AUTH exchange |
| Secrets in logs | `pass`, `smtpPassword` and `SMTP_PASSWORD` are on the logger's redaction list; the sentinel test checks the password and its base64 AUTH PLAIN form are in no log line and no adapter error |
| Content | English, plain text plus simple escaped HTML, rendered by a pure function; content rules of ADR 0014, 0020 and 0022 apply. No seller username anywhere. The mailbox should delete alert mail after 30 days (D-48) |

## Alternatives Considered

- **SES now, as ADR 0022 plans** (strongest alternative): own sending identity with DKIM and a MAIL FROM domain, so alert mail cannot harm the main domain's reputation; bounce handling later. Cons: DNS records, an IAM key, a production-access request and a sandbox period before the first real alert. Why not: the owner wants the MVP running now, and at most 60 emails a day to one internal address do not need it.
- **A transactional mail provider** (Postmark, Mailgun and the like): good deliverability and an HTTP API. Cons: a new processor and contract, DNS work as for SES. Why not: no gain over SES for this volume, and one more account.
- **No email, dashboard only**: nothing to configure. Why not: a deal sells within the hour; nobody watches an internal dashboard all day.

## Consequences

- **Positive**: alerts can go out on the first deploy; no new account, DNS change or IAM key; one runtime dependency without dependencies of its own.
- **Negative**: alert mail shares the sender reputation of the main domain `intra-ai.de`. The owner accepted that risk. No bounce or complaint handling. A crash after the SMTP server accepted a message and before the result is written can send one duplicate.
- **Risks**: a leaked SMTP password gives access to the company mailbox. Mitigation: the password lives only in the root-only `.env` and the password manager, is passed to the worker alone, and is covered by the redaction list and the sentinel test; on a leak, change it at the mail provider and in `.env`, then restart the worker (runbook). The mail server could rate-limit or reject the mail. Mitigation: the code caps of 10 an hour and 60 a day; a failed delivery shows on the dashboard.

## How we check it

- Unit tests: `packages/notify/src/sender.test.ts` (display name, quoted name, bare address; CR/LF, angle brackets and two addresses rejected), `smtp.test.ts` (fake transport: 250, 421, 550, `EAUTH`; an error carrying the password, plain and base64, maps to `{ code, responseCode }` without it), `render.test.ts`.
- `apps/worker/src/env.test.ts`: a partial SMTP set is refused with names only; none set is allowed.
- `apps/worker/src/handlers/flow.test.ts`: SMTP unset leaves the delivery `pending` with `attempt` 0 and no transport call; once set, relay sends it once.
- `apps/worker/src/sentinel.test.ts`: the SMTP password sentinel appears in no log line and no adapter error.
- `tools/deploy-selftest`: `ebay-deploy` refuses a partial SMTP set before any docker call.
- dependency-cruiser rule `nodemailer-only-in-notify` with its fixture.
- CI renders the compose file with `ALERT_FROM=Just-Buy-It <info@intra-ai.de>` and checks the worker gets the value unchanged.
- Live acceptance steps L2 (test mail with `mail:test`) and L8 (a real alert) need the owner's confirmation that the mail arrived with sender "Just-Buy-It".

## Revisit when

- SES is set up for login codes (Phase 1 S3).
- Alerts go to more than one recipient or past 60 a day.
- The mail provider rate-limits or rejects alert mail, or the main domain's mail starts landing in spam.
