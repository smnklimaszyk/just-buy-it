# ADR-0036: Kleinanzeigen listings from saved-search emails only

**Date**: 2026-10-21
**Status**: proposed
**Deciders**: Simon Klimaszyk (D-01)
**Related**: ADR 0002, 0005, 0006, 0010, 0011, 0014, 0018, 0020, 0023; D-11, D-18

## Context

- Kleinanzeigen (kleinanzeigen.de) is the main German private second-hand market for GPUs, RAM and gaming PCs. Its terms (§ 5 Nutzungsbedingungen, https://themen.kleinanzeigen.de/nutzungsbedingungen/, copy saved 2026-10-21) forbid using "Crawler, Spider, Scraper oder andere automatisierte Mechanismen", without express written consent, "um auf die Kleinanzeigen-Dienste zuzugreifen und Inhalte zu sammeln". The same section forbids using content beyond the intended use of the service and collecting information about other users without their consent.
- Simon keeps saved searches on a Kleinanzeigen account. Kleinanzeigen emails new hits to a dedicated alert mailbox on our own mail server, read over IMAP with TLS. The address, host and login live only in the production `.env` and the ADR 0011 secrets register, not in this repo. Receiving these emails is a normal feature of the service.
- Facts from five alert emails received 2026-10-21:
  - `From: Kleinanzeigen <noreply@kleinanzeigen.de>`, signed by DKIM with `d=kleinanzeigen.de`, `s=ka1` and no `l=` tag; the signature covers `date`, `from`, `subject` and `to`, each listed twice in `h=`, so a second copy of any of them added later breaks the signature. kleinanzeigen.de publishes DMARC `p=reject`.
  - Our server's OpenDKIM adds `Authentication-Results: mail.intra-ai.de; dkim=pass ... header.d=kleinanzeigen.de`. It is not the first header line, but it sits above our Postfix `Received ... by mail.intra-ai.de` hop; an A-R header forged inside the message would sit below that hop.
  - Subject `Neue Treffer zu deiner Suche „<label>“`; one `text/html` part of about 59 KB.
  - The body holds a "Neue Treffer ansehen" link with the saved-search id, then per listing a thumbnail on `img.kleinanzeigen.de`, title, price (shapes like `2.450 € VB`, `1.850 €`, `320 €`), an optional "Von Privat" badge, and an "Anzeige ansehen" link to `https://www.kleinanzeigen.de/s-anzeige/<adId>`. Ad links are not click-wrapped today.
  - Every sample held one listing; the wording ("neue Treffer") suggests one email can hold several.
  - Some markup is malformed (a `style=` attribute runs into `class=`).

### Planned for phase B (not part of this decision)

Recorded so phase B starts from it; each point is settled in phase B's own pull requests, not by this record.
- `listing.source` (`ebay` | `kleinanzeigen`) and item key `ka:<adId>`; one-row `ka_mailbox_state(uid_validity text, last_uid bigint, updated_at)`, written in the same transaction as the parsed listings.
- Raw emails are not stored. Parsed fields get ADR 0014 class rules decided then; private sellers' titles are treated like class 1 (6 hours).
- Worker job `ka-poll` every few minutes calls `fetchNew`. The sector `classify` runs on the title only (no aspects).
- Env names, read only in `apps/worker/src/env.ts`: `KA_IMAP_HOST`, `KA_IMAP_PORT`, `KA_IMAP_USER`, `KA_IMAP_PASSWORD` (secret), `KA_TRUSTED_AUTHSERV_ID` (default `mail.intra-ai.de`). None gets a committed default for host, user or password. `KA_IMAP_USER` is also passed to the parser as the expected recipient.
- Replay limits on top of the recipient check: reject an email whose `Date` is older than a set window before its IMAP receive time, and accept only `savedSearchId` values from the owner's known saved searches.
- Price: `fixed` is the asking price; `negotiable` is the asking price with a "VB" mark in the alert; `negotiable_no_price`, `free` and `unknown` never alert on price alone.
- Scam rules on title and price only: too cheap for the segment, "nur Versand", "PayPal Freunde", "Tausch", "defekt", "Bastler".
- Claude screening of the title only, through ADR 0018 masking and the ADR 0020 raw scan. `titleHiddenCharacterKinds` maps onto the ADR 0020 codes (`bidi_control` High; `zero_width`, `bidi_mark`, `soft_hyphen` Medium; `tag` treated like `hidden_directive_text`), and any hidden character raises CAUTION.
- The alert email labels the source "Kleinanzeigen" and links `https://www.kleinanzeigen.de/s-anzeige/<adId>`.
- Ops counts rejects by reason and detail, and alerts on any `not_authenticated`, any `wrong_recipient` or a run of `malformed`.

## Decision

We get Kleinanzeigen listings only from these saved-search alert emails, read over IMAP read-only (EXAMINE, `BODY.PEEK[]`; no flag, move, copy or delete). We trust an email only when the first `Authentication-Results` header is from our own server (`mail.intra-ai.de`), sits above our Postfix hop and says `dkim=pass header.d=kleinanzeigen.de`, that signature covers `from`, `to`, `subject` and `date`, the single From is exactly `noreply@kleinanzeigen.de`, the single To is exactly our alert mailbox, and the subject is the saved-search subject. We never fetch Kleinanzeigen listing pages, search pages or APIs; the email's thumbnail may later be fetched once per listing from `img.kleinanzeigen.de`, as a mail client would, but not in phase A.

Rules:
- Phase A is `packages/kleinanzeigen`: it imports no workspace package, reads no env and makes no HTTP call. Public API from `.` only: `parseAlertEmail`, `DEFAULT_TRUSTED_AUTHSERV_ID`, `createMailboxReader`, `MailboxError` and their types.
- Dependencies, pinned exactly (ADR 0005, newest release at least 7 days old on 2026-10-21): `imapflow` 2.4.2 (IMAP), `postal-mime` 4.0.6 (MIME), `parse5` 8.0.1 (HTML tree built the way a browser builds it, so malformed markup gives the tree a mail client shows).
- The recipient check is what stops a replay: anyone can get a genuine, signed alert sent to their own Kleinanzeigen account and resend it to us unchanged, but its signed To is their address, not ours. The parser takes the expected recipient as a required option and has no default for it.
- The parser anchors on links and text, never on class names or styles. A listing block ends at its "Anzeige ansehen" link; the listing URL is rebuilt as `https://www.kleinanzeigen.de/s-anzeige/<adId>` with no query. It returns all listings or none: any odd block makes the whole email `malformed`. A rejection carries only a reason and a detail code, never header or body text.
- Titles, label and price text are untrusted data. Hidden characters are removed: C0 and C1 controls, every format character (Cf) and every default-ignorable code point. That is wider than zero-width and bidi alone: it also covers Unicode tag characters, variation selectors, the soft hyphen, the Arabic letter mark and the Hangul fillers. Each listing reports which kinds were removed (`titleHiddenCharacterKinds`) and whether any were (`titleHadHiddenCharacters`).
- The IMAP client type the reader uses has no write method. imapflow's logger is off, because its log lines can carry server text. Errors have a fixed message and an allowlisted code, never server text or the password.
- The reader never deletes mail, so the mailbox is the record: an email that fails to parse is parsed again after a fix.

Accepting needs:
- **0002**: the email-link check also allows `https://www.kleinanzeigen.de/s-anzeige/<digits>` with no query or fragment; the outbound allowlist gains `GET` on `img.kleinanzeigen.de` (thumbnail only, phase B) and the string scan bans `kleinanzeigen.de/s-suche`, `api.kleinanzeigen` and `/s-anzeige/` as a request target.
- **0006**: the package table gains `kleinanzeigen` (imports nothing; deps `imapflow`, `postal-mime`, `parse5`) and dependency-cruiser's `leaf-packages-import-no-workspace-package` rule covers it.
- **0010**: a second marketplace arrives as a mail source with its own `source` value, not as a `feed.marketplace_id`; `classify` must work from the title alone for it.
- **0011**: the secrets register gains `KA_IMAP_PASSWORD` (owner Simon, production `.env` only) and the other `KA_*` names.
- **0014**: the retention registry gains rows for Kleinanzeigen listing content and `ka_mailbox_state`, with lifetimes decided under D-11.
- **0018**: Kleinanzeigen titles may be sent to Claude under the same masking; no ad id, thumbnail or image URL is sent.

## Alternatives considered

- **DanielWTE/ebay-kleinanzeigen-api** (open-source scraper on Playwright and httpx): browser automation and scraping, against ADR 0002 and its runtime-image check and against § 5; breaks on layout changes and bot checks.
- **Fetching listing or search pages ourselves**: the automated access § 5 forbids; it would also need an HTTP path outside `packages/ebay`, which ADR 0002 bans.
- **Hosted kleinanzeigen-agent.de**: a third party holds our searches and maybe our account; its standing under the terms is unknown; another processor of personal data under ADR 0018; it costs money.
- **mailparser** instead of postal-mime: 28 packages (html-to-text, htmlparser2, linkify-it, nodemailer) for what postal-mime does with none. **htmlparser2** instead of parse5: not a spec tree builder, 6 packages. **Regex on raw HTML**: breaks on malformed markup and cannot decode entities correctly.

## Consequences

**Positive**
- Our servers send no request to Kleinanzeigen; the only Kleinanzeigen traffic is the email it chose to send us.
- Input is backed by DKIM and DMARC alignment, checked by our own server.
- The mailbox keeps every email, so a parser fix can re-read old ones.

**Negative**
- We see title, price, seller badge and thumbnail only: no description, shipping, location, seller age or rating. Screening and scam rules are weaker than for eBay.
- Kleinanzeigen may bundle hits, send late or not at all. Phase B measures delay (INTERNALDATE minus listing time when known) and hits per email.
- A layout change breaks the parser on purpose; the fix is a new sanitized fixture and a parser change.
- `imapflow` and `postal-mime` release several times a week; a rule in `renovate.json` groups them into one pull request on Monday mornings. `imapflow` brings a second `pino` (10.3.1 next to our 10.4.0), with its logger off.

**Risks**
- A forged `Authentication-Results` header written by the sender. Checked on the mail server on 2026-10-22: OpenDKIM does not strip incoming A-R headers that carry our authserv-id (by default it strips only those naming the host's system name, which is a different name). The parser carries this alone: only the topmost A-R counts, and it must sit above our Postfix hop. If our DKIM check is skipped, the mail arrives without our A-R and the parser rejects it as `below_trusted_hop`; both cases have tests. Server-side hardening (`RemoveARFrom` set to our authserv-id) is open for Simon.
- A flood of mail to the alert mailbox: every FETCH stays at `maxMessages` uids, but UID SEARCH still answers with all matching uids in one response, about 8 bytes per message. That is far below imapflow's default line limit of 1 GiB, so a flood costs memory and one long response rather than errors. Searching in uid windows would bound it if it ever matters.
- Kleinanzeigen wraps ad links in click tracking: the parser returns `no_listings`, and Ops alerts in phase B.
- Someone replays a genuine alert: one sent to their own account fails the recipient check, because its signed To is not our mailbox. A genuine alert to our mailbox that someone else gets hold of (for example from a backup) and resends passes; phase B narrows this with the Date window and the known saved-search ids. The mailbox address stays out of this public repo so it is not handed to anyone aiming mail at it.
- Kleinanzeigen reads storing and screening alert content as use beyond the intended use (§ 5): we keep titles for hours only (phase B, ADR 0014), never republish them, and a person buys by hand (ADR 0002). Simon decides before phase B goes live.
- The test fixtures in `packages/kleinanzeigen/src/testing/fixtures/` publish Kleinanzeigen's own email template (layout, CSS, legal footer, about 57 KB each) in this public repo, with only ids, title, price and tokens swapped. § 5 forbids making Kleinanzeigen content public without consent. Simon accepted this risk on 2026-10-22: the fixtures stay whole, because a cut-down template would no longer show whether the parser still reads the real layout. The fixtures also keep, as delivered, our own LMTP hop line with the mail host's local name and the sender's relay host names and private addresses in its `Received` lines; none of these is a secret.
- The Kleinanzeigen account is closed: no automation touches the account, so this is unlikely; alerts stop and Ops sees no new mail.
- The mailbox password leaks: it gives read access to one alert mailbox; it lives only in the production `.env` and the password manager (ADR 0011).

## How we check it

- Parser tests on six sanitized fixtures (ids, ad links, image paths and message ids in fake ranges, checked by a scan test) and synthetic emails: every reject code, the forged and misplaced A-R cases, `l=` tag, a signature that does not cover `to`, look-alike From and hosts, a To that is not the expected mailbox or appears twice, two listings, duplicates, 51 listings, injection and hidden-character titles (tag characters and variation selectors included), oversize and garbage input. Nothing throws.
- Some markup costs parse5 time that grows with the square of its size: a tag with tens of thousands of attributes, long runs of children moved by foster parenting or the adoption agency, text inside a table that parse5 replays at once, and single steps that scan a deep stack of open elements (scope checks, the adoption agency, rebuilding formatting elements, stray end tags). parse5 also reopens every formatting element still listed in each new block, so 34 KB of input can become a million elements, more than the worker's 160 MB heap holds. Four limits cover this; each rejects the email as `malformed/html_too_complex`. At most 256 elements may be open at once (a real alert nests about 30 deep), which keeps every scan of that stack short. At most 30,000 insertions into the tree (a real alert makes about 3,700, most of them pieces of its style sheet text; one with 50 listings about 9,800), which keeps the tree and the walk over it small. No element may carry more than 64 attributes, also counting those a later `<html>` or `<body>` tag adds to the first (a real alert has at most 8), because every reopened copy shares them. And the parser gets the HTML in 1 KB pieces and stops after 2 s, checked after each piece and on every change to the tree; within the caps above only a tag with tens of thousands of attributes still runs into it. A real alert takes 3 to 5 ms of CPU time once warm; the first call in a fresh process takes 20 to 60 ms, one with 50 listings up to about 150 ms. The limit is wall-clock time (`performance.now`), which also counts time spent waiting for a CPU; 2 s leaves room for a host that is several times oversubscribed, where a review measured a 50-listing alert at up to about 670 ms. Thread CPU time would not depend on load, but packages may not read `process` (ADR 0006), so it would need a clock passed in by the app. Tests feed each of these shapes (all rejected, the ones that need the deadline in under 4 s) and a listing nested 200 deep that is still read. The chunked parse uses parse5's `Parser` class, which parse5 marks internal; these tests run on every Renovate update of parse5. After parsing, the work stays linear: a run of more than 30 combining marks keeps its first 30 before NFC, which sorts each run in time that grows with its square, and a link goes to `URL.parse` only if its host part (after the scheme and slashes, up to the next slash, backslash, `?` or `#`) has at most 255 characters, because the URL parser runs the host through IDNA, which is just as slow on such runs. Each distinct href is read once per email, because every reopened copy of an `<a>` repeats its href.
- An attached message (`message/rfc822`) stays an attachment (`maxRfc822NestingDepth: 0`): postal-mime would otherwise render it into the HTML, headers included, and a chain of nested ones made a 570 KB message need more than the worker's 160 MB heap, before any check had run. A test shows an alert inside an attached message is not read (`no_html`).
- Reader tests against a fake IMAP client only (no socket): `{ readOnly: true }`, `BODY.PEEK` source fetch, look-back and uid state, oversize mail, timeouts, logout always runs, and the password and server text never reach the error. A SEARCH the server rejects (imapflow returns `false`) fails the call instead of moving the state; FETCH rows for other or repeated uids are ignored; a backlog is fetched in commands of at most `maxMessages` uids.
- The `ImapClient` type has no write method; a source test bans `messageFlags`, `messageDelete`, `messageMove`, `messageCopy`, `append(`, `EXPUNGE` and `readOnly: false` in `src/mailbox/`.
- dependency-cruiser: `packages/kleinanzeigen` imports no workspace package.
- ADR 0002's planned ESLint ban on `fetch`, `node:http(s)` and `undici` outside `packages/ebay` also covers this package (not yet in `eslint.config.js`; until then review covers it). The ADR 0002 string scan gains `kleinanzeigen.de/s-suche`, `api.kleinanzeigen` and `/s-anzeige/` as a request target in `apps/` or `packages/`.
- Manual, phase B: one live read-only run against the real mailbox, with flags compared before and after.

## Revisit when

- Kleinanzeigen changes § 5, offers an official API or gives written consent to automated access.
- The alert email layout, sender address or DKIM domain changes, or ad links become click-wrapped.
- Phase B shows alerts too late or too incomplete to be worth sending, or Ops shows a lasting rise in `malformed` or `no_listings`.
- The mail server or its DKIM checker changes (new authserv-id or Postfix hop name).
