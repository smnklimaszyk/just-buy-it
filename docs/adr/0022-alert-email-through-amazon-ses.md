# ADR-0022: Alert, digest, ops and login email through Amazon SES

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0011, 0014, 0015, 0020, 0021, 0024, 0027; D-03, D-04, D-19, D-37, D-48; [decisions](../planning/02-decisions.md)

## Context

- Email carries alerts, hourly and 21:00 digests, ops mail (ADR 0024) and Better Auth login codes (ADR 0021). A broken sender means missed deals, no login.
- DMARC alignment: Easy DKIM aligns; SPF aligns only with a custom MAIL FROM and relaxed alignment ([AWS](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)). MAIL FROM needs one MX `10 feedback-smtp.eu-central-1.amazonses.com` and `v=spf1 include:amazonses.com ~all`; detection can take 72 h ([AWS](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)).
- Sandbox: verified recipients only, 200 messages per 24 h, 1 per second; production-access answer within 96 h ([AWS](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)). Quotas count recipients.
- Suppressed addresses are accepted, not sent, and still use quota; only hard bounces are added; lookups need the exact stored case ([AWS](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)).
- `ses:FromAddress` covers only send actions ([AWS](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html)).
- $0.10 per 1,000 emails. Delivered bodies cannot be purged (ADR 0014).

## Decision

All mail goes through Amazon SES in eu-central-1 (SESv2 `SendEmail`, `packages/notify`, Notifier port) from the domain identity `alerts.intra-ai.de` with Easy DKIM and MAIL FROM `mail.alerts.intra-ai.de`. One recipient per call, one configuration set, account-level suppression (BOUNCE, COMPLAINT), no inbound endpoint.

| Part | Rule |
|---|---|
| MAIL FROM | MX failure behaviour "use default MAIL FROM", so DKIM carries DMARC while MX is pending |
| DMARC | `_dmarc.alerts.intra-ai.de` = `v=DMARC1; p=none`, relaxed (no `aspf`/`adkim`), no `rua` until D-48 is decided |
| Recipients | Alerts, digests, ops: one alert address (Simon's mailbox, D-48). Login codes: each user's own address. Stored and sent as configured, never case-normalised |
| Buyer profile | The watch's `buyer_profile`, one per alert (D-04); the private what-if is never emailed; seller-type wording per ADR 0027 |
| Sandbox (D-19) | Request production access (transactional) in week one, not a go-live gate; until granted, alert and login addresses are verified identities. If D-19 skips the request, a colleague must be verified before first login and the worst-case day (ops mail capped at 20, ADR 0024; login rate limit, ADR 0021) must stay under 200 messages |
| IAM | One key, two statements: (1) `ses:SendEmail`, `ses:SendRawEmail` on the identity and configuration-set ARNs, `StringEquals ses:FromAddress`; (2) `ses:GetAccount`, `ses:GetSuppressedDestination` on `*`. If simulation denies a valid send, (1) uses `Resource *`, same condition |
| Content | React Email plus plain text; content rules in ADR 0014, 0020, 0021, 0027 |
| Bounce events | None in v1 |

**MVP amendment (2026-10-21)**: for the MVP, alert email goes over SMTP from the existing mailbox, not through SES ([ADR 0035](0035-alert-email-over-smtp.md), owner decision). This record still holds for login codes (Phase 1 S3) and is the target for alert, digest and ops mail when SES is set up. MVP alert email is plain text plus simple escaped HTML from a pure render function (no React Email), one email per item, to the one alert address; the content rules above still apply. The mailbox should delete alert mail after 30 days (D-48).

## Alternatives considered

- **Postmark, Resend**: US-hosted account data; second vendor and processor (Postmark approves faster).
- **SMTP via Intra AI's mail host**: mailbox password as a secret, unverified limits, risks the main domain.
- **Telegram first**: login still needs email; later optional mirror.
- **SNS HTTPS for bounces**: a second public inbound endpoint; use SQS polling if needed.

## Consequences

- **Positive**: one EU sender for cents (300 a day about $0.03); DKIM and SPF align; main domain kept apart.
- **Negative**: DNS work and the MAIL FROM wait before slice 1. `alert_delivery.status = sent` (ADR 0015) means "accepted by SES". With `p=none` and no `rua`, spoofing is not rejected and failures go unseen. One SES suspension stops alerts and login.
- **Risks**:
  - Alert address hard-bounces once; every alert is then dropped and burns quota silently. The hourly worker check (`GetSuppressedDestination` per recipient) fails healthchecks.io `ses-suppression`, which mails Simon outside SES. Runbook: `aws sesv2 delete-suppressed-destination` with exact case.
  - SES pauses sending: the hourly check reads `GetAccount`; break-glass CLI login (ADR 0021) keeps the dashboard up.
  - DNS records late: Simon adds them in week one with deals.intra-ai.de (needed first for the deletion endpoint); the default-MAIL FROM fallback keeps DKIM alignment while the MX is pending.

## How we check it

- DNS script in `infra/`, no secrets, in the manual contract run: three DKIM CNAMEs, exactly one MX with the eu-central-1 host, SPF TXT, DMARC TXT with a `p` tag; fails on `aspf=s`.
- Go-live runbook and after any subdomain DNS change: `ops:send-test-mail` on production shows `dkim=pass`, `spf=pass`, `dmarc=pass`; headers (no body) and date go into the [Phase 0 checklist](../planning/phases/phase-0.md). Production only; the non-prod key can send only to simulator addresses (ADR 0011); a later DNS mistake is caught only by the DNS script.
- Adapter test: configuration set and From set, one unchanged recipient per call.
- CI test on `infra/aws/iam/` policy JSON: exactly the two statements above, no wildcard actions; quarterly ADR 0011 simulation denies other From addresses and actions.
- Unit test: suppressed recipient or paused status fails the check.
- Ops page metrics: messages sent in the last 24 h against the quota (`GetAccount`) and the last suppression check. DMARC is not an Ops page metric.
- `infra/` changes merge after CI and a fresh-context Claude Code review (D-37).

## Revisit when

- A bounce or complaint occurs: add an event destination (EventBridge or SNS into SQS, worker-polled).
- D-48 is decided: add `rua`, require it in the DNS check, quarantine after 14 days of reports with 98% or more passing; `p=reject` 90 days later with no failing sources.
- Sends near quota, or colleagues join (group address or per-user alerts; claim action if two could buy a listing).
- Production access refused, SES pause, or a different D-19.
