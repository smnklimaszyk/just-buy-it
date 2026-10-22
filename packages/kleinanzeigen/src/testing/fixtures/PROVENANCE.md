# Where these fixtures come from

Each `.eml` file started as a real email that Kleinanzeigen sent to our alert mailbox on 2026-10-21. [`scripts/sanitize.py`](../../../scripts/sanitize.py) turned them into these files. The real emails are not in the repo, and neither is the list of original values the script writes.

## What the script changed

Headers keep their order and names. Replaced:

- `To`, `Delivered-To` and every `for <...>` with `mailbox@example.invalid`.
- `Return-Path` and the LMTP `envelope-from` with `bounces+0000000-0000-mailbox=example.invalid@em4286.kleinanzeigen.de`.
- `Message-ID` with `<10000000NN.1.1792580000000@saved-search-application-fixture>`, where NN is the file number below.
- The LMTP id, the Postfix and SendGrid queue ids, `header.b=` in `Authentication-Results`, and `bh=` and `b=` in `DKIM-Signature`: each character becomes `0`, `A` or `a` by its class, other characters stay. The `header.b=` value is still the start of the `b=` value, as in the real mail. The signatures no longer verify.
- The sender's internal host names in `Received` with `saved-search-application-fixture`, `desktop-fixture` and `recvd-fixture`.
- Removed: `X-SG-*`, `X-Entity-ID`, `X-Spam*` and `X-Rspamd-*`.

Kept as sent: the `Authentication-Results` wording, `From`, `Date`, `Subject` (the saved-search labels are our own search terms), the MIME headers and the other `Received` lines.

The body was decoded from quoted-printable, changed, and encoded again with CRLF line ends and the sender's line length. Replaced:

- The saved-search id in the "Neue Treffer ansehen" link (`id=`) and in the ad link (`sa=`), with `900000001` to `900000099`. Two emails came from the same saved search and share one fake id.
- The ad id in the "Anzeige ansehen" link, with `9000000001` to `9000000099`.
- The image path, with `/images/00/00000000-0000-4000-8000-0000000000NN`.
- The open-pixel token, with `upn=FIXTURE`.
- The listing title, in both the bold cell and the image `alt` text, with an invented title of the same kind.
- The price, with an invented one of the same shape.

Everything else in the HTML is unchanged, including the malformed `style=` attribute.

## Making a new fixture

For a new fixture (for example after a layout change), add a row to `PLAN` in `scripts/sanitize.py` and run it as its docstring says, with the source emails and the originals list outside the repo. The script stops when an email does not have the shape it expects (one ad link, one image, one title, one price); then follow these steps by hand or extend the script:

1. Save the email as delivered (with CRLF line ends) outside the repo. Never copy it into the repo as it is.
2. Headers: apply every replacement in "What the script changed" above, in place, keeping order and names. Drop the listed tracking headers.
3. Body: decode quoted-printable. Replace the saved-search id (`id=` and `sa=`), every ad id, every image folder and uuid, and the `upn=` token, with the next unused values from the fake ranges. Replace each listing title in both the image `alt` text and the bold title cell with an invented title of the same kind, and each price with an invented one of the same shape. Look for ids in any other shape too: click-wrapped links, query values, slugs.
4. Encode quoted-printable again with CRLF line ends.
5. Add the invented titles to the list in the "carries only an invented listing title" test in `src/fixtures.test.ts`, add the file to `EXPECTED_FILES`, and add a row to the table below.
6. Run `src/fixtures.test.ts`. It fails on any run of six or more digits that is not zeros, a fake id or a named public number, and on any title that is not on the invented list.

## Files

| NN | File | Source | Replaced in the body |
|---|---|---|---|
| 01 | `alert-gpu-negotiable.eml` | RTX 4090 search, private seller, price with VB | saved search 900000001, ad 9000000001, title, price now `2.450 € VB` |
| 02 | `alert-gpu-5090.eml` | RTX 5090 search, private seller, price with VB | saved search 900000002, ad 9000000002, title, price now `11.200 € VB` |
| 03 | `alert-pc-fixed.eml` | RTX 3090 search (all categories), gaming PC, private seller, fixed price | saved search 900000003, ad 9000000003, title, price now `1.850 €` |
| 04 | `alert-gpu-fixed.eml` | RTX 4090 search (same saved search as 01), private seller, fixed price | saved search 900000001, ad 9000000004, title, price now `2.380 €` |
| 05 | `alert-ram-business.eml` | DDR5 search, no "Von Privat" badge, fixed price | saved search 900000004, ad 9000000005, title, price now `320 €` |
| 06 | `activation.eml` | account activation email | headers as above; the whole body replaced by a short HTML page without links |

`src/fixtures.test.ts` checks that every id in these files stays inside the fake ranges.
