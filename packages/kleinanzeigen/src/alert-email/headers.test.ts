import { describe, expect, it } from "vitest";
import { checkAuthentication, checkRecipient, checkSender, matchSubject, type EmailHeader } from "./headers.js";

// Header lists in the shape postal-mime gives them: document order, lower-case keys, values
// unfolded with the fold whitespace kept. The values copy the sanitized fixtures.

const TRUSTED = "mail.intra-ai.de";

const AR_PASS =
  "mail.intra-ai.de;\tdkim=pass (2048-bit key; unprotected) header.d=kleinanzeigen.de header.i=@kleinanzeigen.de header.a=rsa-sha256 header.s=ka1 header.b=AA/a0a0A;\tdkim-atps=neutral";

const OUR_HOP =
  "from o22.ptr2619.kleinanzeigen.de (o22.ptr2619.kleinanzeigen.de [192.0.2.10])\tby mail.intra-ai.de (Postfix) with ESMTPS id 0000AA0A00A\tfor <mailbox@example.invalid>; Wed, 21 Oct 2026 12:54:46 +0200 (CEST)";
const LMTP_HOP =
  "from mail.intra-ai.de\tby ubuntu with LMTP\tid 0AAAAAaA0AaAAaAAaaaAaa\t(envelope-from <bounces+0000000-0000-mailbox=example.invalid@em4286.kleinanzeigen.de>)\tfor <mailbox@example.invalid>; Wed, 21 Oct 2026 12:54:47 +0200";
const SENDER_HOP =
  "from saved-search-application-fixture (ip-10-0-0-1.eu-central-1.compute.internal [10.0.0.1])\tby mailout-smtp-3.localdomain (Postfix) with ESMTP id 0A0AA00\tfor <mailbox@example.invalid>; Wed, 21 Oct 2026 10:54:44 +0000 (UTC)";

const SIGNED_HEADERS =
  "date:from:subject:mime-version:to:content-type:\tcontent-transfer-encoding:cc:content-type:date:from:subject:to";
const SIGNATURE_B =
  "AA/a0a0Aa/A0aAa0aAAAAAaa0aAaaAaAA0AAaAAAAAaa0/Aa0aaAaAAAaAAAAAa0a0aA\taa/aa0a0AAaaaaAAAAaAA0A0AA0aA+00AAaa0A0A0aAa0";

function dkimSignature(options: { d?: string; h?: string; b?: string; extra?: string } = {}): string {
  const { d = "kleinanzeigen.de", h = SIGNED_HEADERS, b = SIGNATURE_B, extra = "" } = options;
  return `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${d};\th=${h};\ts=ka1; t=1792580085;${extra}\tbh=aAA0aa0aaA/0AAa0aaaAAaaaa+AAAaaaaAA0AAAaAAA=;\tb=${b}`;
}

type DeliveredOptions = {
  authenticationResults?: string[];
  hop?: string | null;
  belowHop?: EmailHeader[];
  signatures?: string[];
};

function delivered(options: DeliveredOptions = {}): EmailHeader[] {
  const { authenticationResults = [AR_PASS], hop = OUR_HOP, belowHop = [], signatures = [dkimSignature()] } = options;
  return [
    { key: "return-path", value: "<bounces+0000000-0000-mailbox=example.invalid@em4286.kleinanzeigen.de>" },
    { key: "delivered-to", value: "mailbox@example.invalid" },
    { key: "received", value: LMTP_HOP },
    ...authenticationResults.map((value) => ({ key: "authentication-results", value })),
    ...(hop === null ? [] : [{ key: "received", value: hop }]),
    ...belowHop,
    ...signatures.map((value) => ({ key: "dkim-signature", value })),
    { key: "received", value: SENDER_HOP },
    { key: "date", value: "Wed, 21 Oct 2026 10:54:45 +0000 (UTC)" },
    { key: "from", value: "Kleinanzeigen <noreply@kleinanzeigen.de>" },
    { key: "message-id", value: "<1000000001.1.1792580000000@saved-search-application-fixture>" },
    { key: "subject", value: "Neue Treffer zu deiner Suche =?UTF-8?B?4oCeUlRYIDQwOTDigJw=?=" },
    { key: "mime-version", value: "1.0" },
    { key: "to", value: "mailbox@example.invalid" },
    { key: "content-type", value: "text/html; charset=utf-8" },
  ];
}

describe("checkAuthentication", () => {
  // Our OpenDKIM adds its result above the Received line our Postfix adds; anything the sender
  // wrote sits below that line.
  it.each<[string, EmailHeader[], unknown]>([
    [
      "no Authentication-Results header",
      delivered({ authenticationResults: [] }),
      { ok: false, detail: "no_authentication_results" },
    ],
    [
      "a forged pass below our Postfix hop when our server added none",
      delivered({ authenticationResults: [], belowHop: [{ key: "authentication-results", value: AR_PASS }] }),
      { ok: false, detail: "below_trusted_hop" },
    ],
    [
      "a forged pass with a forged Received line naming our server below it",
      delivered({
        authenticationResults: [],
        belowHop: [
          { key: "authentication-results", value: AR_PASS },
          { key: "received", value: OUR_HOP },
        ],
      }),
      { ok: false, detail: "below_trusted_hop" },
    ],
    ["no Received line from our Postfix", delivered({ hop: null }), { ok: false, detail: "below_trusted_hop" }],
    [
      "a hop on a server whose name only starts with ours",
      delivered({ hop: OUR_HOP.replace("by mail.intra-ai.de (", "by mail.intra-ai.de.evil.example (") }),
      { ok: false, detail: "below_trusted_hop" },
    ],
  ])("reads our own result only above our hop: %s", (_name, headers, expected) => {
    expect(checkAuthentication(headers, TRUSTED)).toEqual(expected);
  });

  it.each<[string, string]>([["another server's id", AR_PASS.replace("mail.intra-ai.de;", "mx.google.com;")]])(
    "rejects a topmost result with %s as authserv-id",
    (_name, value) => {
      expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({
        ok: false,
        detail: "foreign_authserv_id",
      });
    },
  );

  it("reports a foreign authserv-id when told to trust another server", () => {
    expect(checkAuthentication(delivered(), "other.example")).toEqual({ ok: false, detail: "foreign_authserv_id" });
  });

  it("accepts our authserv-id in another case and followed by a version", () => {
    const value = AR_PASS.replace("mail.intra-ai.de;", "MAIL.Intra-AI.de 1;");
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({ ok: true });
  });

  it("accepts a comment after our authserv-id", () => {
    const value = AR_PASS.replace("mail.intra-ai.de;", "mail.intra-ai.de (OpenDKIM; v2);");
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({ ok: true });
  });

  it("rejects a topmost result where DKIM failed", () => {
    const value = AR_PASS.replace("dkim=pass", 'dkim=fail reason="signature verification failed"');
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_not_pass",
    });
  });

  it("rejects a pass result for another domain", () => {
    const value = AR_PASS.replace("header.d=kleinanzeigen.de", "header.d=evil.example");
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_not_pass",
    });
  });

  it("rejects a pass result for a subdomain", () => {
    const value = AR_PASS.replace("header.d=kleinanzeigen.de", "header.d=sub.kleinanzeigen.de");
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_not_pass",
    });
  });

  it("ignores a forged pass result below our own failed one", () => {
    const fail = AR_PASS.replace("dkim=pass", "dkim=fail");
    const headers = delivered({
      authenticationResults: [fail],
      belowHop: [{ key: "authentication-results", value: AR_PASS }],
    });
    expect(checkAuthentication(headers, TRUSTED)).toEqual({ ok: false, detail: "dkim_not_pass" });
  });

  it("uses only the topmost result even when a second one above the hop says pass", () => {
    const fail = AR_PASS.replace("dkim=pass", "dkim=fail");
    expect(checkAuthentication(delivered({ authenticationResults: [fail, AR_PASS] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_not_pass",
    });
  });

  it("does not read a pass result written inside a comment", () => {
    const value = "mail.intra-ai.de; dkim=fail (dkim=pass header.d=kleinanzeigen.de) header.d=evil.example";
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_not_pass",
    });
  });

  it("rejects a pass result that names two signing domains", () => {
    const value = "mail.intra-ai.de; dkim=pass header.d=evil.example header.d=kleinanzeigen.de header.b=AA/a0a0A";
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_not_pass",
    });
  });

  it("rejects a kleinanzeigen signature with a body length tag", () => {
    expect(checkAuthentication(delivered({ signatures: [dkimSignature({ extra: " l=1234;" })] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_length_tag",
    });
  });

  it("rejects a kleinanzeigen signature that does not sign To", () => {
    const h = "date:from:subject:mime-version:content-type:content-transfer-encoding:cc";
    expect(checkAuthentication(delivered({ signatures: [dkimSignature({ h })] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_headers_not_signed",
    });
  });

  it("rejects a kleinanzeigen signature that leaves out any of From, To, Subject or Date", () => {
    for (const name of ["from", "to", "subject", "date"]) {
      const h = SIGNED_HEADERS.split(":")
        .filter((header) => header.trim() !== name)
        .join(":");
      expect(checkAuthentication(delivered({ signatures: [dkimSignature({ h })] }), TRUSTED)).toEqual({
        ok: false,
        detail: "dkim_headers_not_signed",
      });
    }
  });

  it("checks every kleinanzeigen signature when the pass result has no header.b", () => {
    const authenticationResults = ["mail.intra-ai.de; dkim=pass header.d=kleinanzeigen.de"];
    const signatures = [dkimSignature(), dkimSignature({ b: "BBBBBBBBBBBB", extra: " l=10;" })];
    expect(checkAuthentication(delivered({ authenticationResults, signatures }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_length_tag",
    });
  });

  it("ignores other domains' signatures and kleinanzeigen signatures that header.b does not name", () => {
    const signatures = [
      dkimSignature({ d: "sendgrid.example", h: "from", extra: " l=10;" }),
      dkimSignature({ b: "BBBBBBBBBBBB", h: "from", extra: " l=10;" }),
      dkimSignature({ h: "Date :\tFrom: Subject:TO" }),
    ];
    expect(checkAuthentication(delivered({ signatures }), TRUSTED)).toEqual({ ok: true });
  });

  it("rejects a pass result when no kleinanzeigen DKIM-Signature is in the message", () => {
    expect(checkAuthentication(delivered({ signatures: [] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_headers_not_signed",
    });
  });

  it("rejects a pass result when no kleinanzeigen signature starts with its header.b", () => {
    expect(checkAuthentication(delivered({ signatures: [dkimSignature({ b: "BBBBBBBBBBBB" })] }), TRUSTED)).toEqual({
      ok: false,
      detail: "dkim_headers_not_signed",
    });
  });

  it("rejects our authserv-id followed by a token that is not a version", () => {
    const value = AR_PASS.replace("mail.intra-ai.de;", "mail.intra-ai.de evil.example;");
    expect(checkAuthentication(delivered({ authenticationResults: [value] }), TRUSTED)).toEqual({
      ok: false,
      detail: "foreign_authserv_id",
    });
  });
});

// The delivered headers with every header named `key` replaced by one header per value.
function withHeaders(key: string, values: string[]): EmailHeader[] {
  return [...delivered().filter((header) => header.key !== key), ...values.map((value) => ({ key, value }))];
}

describe("checkSender", () => {
  it("rejects a message without From", () => {
    expect(checkSender(withHeaders("from", []))).toEqual({ ok: false, detail: "from_missing" });
  });

  it("rejects two From headers", () => {
    const from = "Kleinanzeigen <noreply@kleinanzeigen.de>";
    expect(checkSender(withHeaders("from", [from, from]))).toEqual({ ok: false, detail: "from_not_single" });
  });

  it("accepts the sender address alone or with a name, in any case", () => {
    for (const from of ["Kleinanzeigen <noreply@kleinanzeigen.de>", "noreply@kleinanzeigen.de", "<NoReply@Kleinanzeigen.DE>"]) {
      expect(checkSender(withHeaders("from", [from])), from).toEqual({ ok: true });
    }
  });

  it("rejects a From that is not exactly one mailbox noreply@kleinanzeigen.de", () => {
    const spoofs = [
      "Kleinanzeigen <noreply@kleinanzeigen.de.evil.example>",
      "Kleinanzeigen <info@kleinanzeigen.de>",
      "Kleinanzeigen",
      '"noreply@kleinanzeigen.de" <evil@evil.example>',
      "noreply@kleinanzeigen.de, evil@evil.example",
      "Kleinanzeigen: noreply@kleinanzeigen.de;",
      "",
    ];
    for (const from of spoofs) {
      expect(checkSender(withHeaders("from", [from])), from).toEqual({ ok: false, detail: "from_address" });
    }
  });
});

describe("checkRecipient", () => {
  it("rejects a genuine alert that was sent to someone else", () => {
    expect(checkRecipient(delivered(), "other@example.invalid")).toEqual({ ok: false, detail: "to_address" });
  });

  it("rejects a message without To", () => {
    expect(checkRecipient(withHeaders("to", []), "mailbox@example.invalid")).toEqual({
      ok: false,
      detail: "to_missing",
    });
  });

  it("rejects two To headers", () => {
    const to = ["mailbox@example.invalid", "mailbox@example.invalid"];
    expect(checkRecipient(withHeaders("to", to), "mailbox@example.invalid")).toEqual({
      ok: false,
      detail: "to_not_single",
    });
  });

  it("accepts our mailbox with a name or in another case on either side", () => {
    expect(checkRecipient(withHeaders("to", ["Mailbox <MAILBOX@example.invalid>"]), "mailbox@example.invalid")).toEqual({
      ok: true,
    });
    expect(checkRecipient(delivered(), "Mailbox@Example.Invalid")).toEqual({ ok: true });
  });

  it("rejects a To that is not exactly one mailbox", () => {
    for (const to of ["mailbox@example.invalid, other@example.invalid", "Alerts: mailbox@example.invalid;", "Mailbox"]) {
      expect(checkRecipient(withHeaders("to", [to]), "mailbox@example.invalid"), to).toEqual({
        ok: false,
        detail: "to_address",
      });
    }
  });
});

describe("matchSubject", () => {
  const SUBJECT = "Neue Treffer zu deiner Suche „PC-Zubehör & Software - rtx 4090 in Ganz Deutschland“";

  it("reads the saved-search label from the decoded subject", () => {
    expect(matchSubject(delivered(), SUBJECT, 200)).toEqual({
      ok: true,
      label: "PC-Zubehör & Software - rtx 4090 in Ganz Deutschland",
    });
  });

  it("cleans the subject before matching", () => {
    const subject = "\u{200B}Neue\u{00A0}Treffer zu deiner  Suche „rtx\u{200B} 4090\u{00A0}OVP“ ";
    expect(matchSubject(delivered(), subject, 200)).toEqual({ ok: true, label: "rtx 4090 OVP" });
  });

  it("rejects any other subject", () => {
    const others = [
      "Aktiviere dein Konto bei Kleinanzeigen",
      `Re: ${SUBJECT}`,
      "Neue Treffer zu deiner Suche rtx 4090",
      'Neue Treffer zu deiner Suche "rtx 4090"',
      `${SUBJECT} jetzt ansehen`,
      undefined,
    ];
    for (const subject of others) expect(matchSubject(delivered(), subject, 200), subject).toEqual({ ok: false });
  });

  it("caps the label at the given number of code points", () => {
    const result = matchSubject(delivered(), `Neue Treffer zu deiner Suche „${"x".repeat(500)}“`, 200);
    expect(result).toEqual({ ok: true, label: "x".repeat(200) });
  });

  it("rejects a label that is empty after cleaning", () => {
    expect(matchSubject(delivered(), "Neue Treffer zu deiner Suche „ \u{200B} “", 200)).toEqual({ ok: false });
  });

  it("rejects a message with two Subject headers", () => {
    const headers = withHeaders("subject", ["Neue Treffer zu deiner Suche =?UTF-8?B?4oCeUlRYIDQwOTDigJw=?=", "Hallo"]);
    expect(matchSubject(headers, SUBJECT, 200)).toEqual({ ok: false });
  });
});
