// Synthetic Kleinanzeigen alert emails for tests in this package. Not built, not exported.
// The markup copies the layout of fixtures/alert-gpu-negotiable.eml; ids come from the fake ranges
// (ad 9000000011 and up, saved search 900000011), so they never match a real listing.

export type SyntheticListing = {
  adId?: string;
  // HTML source of the title cell and the price span, entities as written.
  titleHtml?: string;
  priceHtml?: string;
  privateSeller?: boolean;
  // null leaves the image out.
  imgSrc?: string | null;
  // The "Anzeige ansehen" href; by default the real shape with sa= and tracking parameters.
  adHref?: string;
};

export type AlertHtmlOptions = {
  listings?: SyntheticListing[];
  savedSearchId?: string;
  // The "Neue Treffer ansehen" href; null leaves the link out.
  savedSearchHref?: string | null;
};

const SAVED_SEARCH_ID = "900000011";
const UTM = "utm_source=system_email&utm_medium=email&utm_campaign=email-SavedSearch";

function attributeText(html: string): string {
  return html.replaceAll('"', "&quot;");
}

function listingHtml(listing: SyntheticListing, index: number, savedSearchId: string): string {
  const adId = listing.adId ?? `90000000${11 + index}`;
  const titleHtml = listing.titleHtml ?? `Synthetic RTX 4090 Nummer ${index + 1}`;
  const priceHtml = listing.priceHtml ?? "2.450 € VB";
  const imgSrc =
    listing.imgSrc === undefined
      ? `https://img.kleinanzeigen.de/api/v1/prod-ads/images/00/00000000-0000-4000-8000-0000000000${11 + index}?rule=$_12.JPG`
      : listing.imgSrc;
  const adHref =
    listing.adHref ?? `https://www.kleinanzeigen.de/s-anzeige/${adId}?sa=${savedSearchId}&amp;${UTM}&amp;utm_content=ViewAd`;
  const image =
    imgSrc === null
      ? ""
      : `<img src="${imgSrc}" alt="Bild zur Anzeige ${attributeText(titleHtml)}" width="140" style="display:block;border:none;border-radius:4px;object-fit: cover;" class="t_w100p m_w100p"/>`;
  const badge =
    listing.privateSeller === false
      ? ""
      : `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="text-align:left;font-size:16px;padding-bottom:8px;vertical-align:middle;">
          <span style="background-color:#F4F2EF;color:#504E48;font-size:12px;padding: 2px 5px;border-radius: 4px;"> Von Privat </span>
        </td></tr></table>`;
  return `
<!-- Original layout for non-Real Estate ads -->
<table cellpadding="0" cellspacing="0" border="0" width="90%" align="center" style="margin:auto" class="d_center" role="none">
  <tr>
    <td width="25%" class="t_w30p m_w33p" style="padding-top:24px;padding-bottom:24px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" role="none"><tr>
        <td valign="top" style="position:relative;padding-right:10px;">
          ${image}
        </td>
      </tr></table>
    </td>
    <td width="75%" class="t_w70p m_w67p" valign="top" style="padding-bottom:24px;padding-top:24px">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" role="none"><tr><td valign="top" width="100%">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="none"><tr>
          <td style="color:#0C0C0B;text-align:left;font-size:16px;padding-bottom:8px;font-weight:700"> ${titleHtml} </td>
        </tr></table>
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="none"><tr>
          <td style="color:#326916;text-align:left;font-size:16px;padding-bottom:8px" class="m_pb12px">
            <span style="font-weight:700">${priceHtml}</span>
          </td>
        </tr></table>
        ${badge}
      </td></tr></table>
    </td>
  </tr>
</table>
<table cellpadding="0" cellspacing="0" border="0" width="200" align="center" style="margin:auto;border-collapse:separate" class="d_center t_mauto t_w44p m_w90p" role="none">
  <tr><td style="padding-bottom:24px"><div style="overflow:hidden;border-radius:24px;border:2px solid #9F9D98;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" role="none"><tr>
      <td style="color:#326916;text-align:center;font-size:14px;height:44px;font-weight:700" height="44">
        <a href="${adHref}" style="color:#326916;line-height:130%;display:block;text-decoration:none;outline:0" title="Anzeige ansehen">Anzeige ansehen</a>
      </td>
    </tr></table>
  </div></td></tr>
</table>`;
}

export type AlertEmailOptions = AlertHtmlOptions & {
  // The decoded subject; it is sent RFC 2047 encoded like the real ones.
  subject?: string;
  // Values of the Authentication-Results headers our server adds above its Postfix hop, top first.
  authenticationResults?: string[];
  // Values of the From headers.
  from?: string[];
  // Values of the To headers.
  to?: string[];
  // Whole header lines the sender wrote, placed below our Postfix hop.
  senderHeaders?: string[];
};

const AUTHENTICATION_RESULTS =
  "mail.intra-ai.de;\r\n\tdkim=pass (2048-bit key; unprotected) header.d=kleinanzeigen.de header.i=@kleinanzeigen.de header.a=rsa-sha256 header.s=ka1 header.b=AA/a0a0A;\r\n\tdkim-atps=neutral";
const DKIM_SIGNATURE =
  "v=1; a=rsa-sha256; c=relaxed/relaxed; d=kleinanzeigen.de;\r\n\th=date:from:subject:mime-version:to:content-type:\r\n\tcontent-transfer-encoding:cc:content-type:date:from:subject:to;\r\n\ts=ka1; t=1792580085;\r\n\tbh=aAA0aa0aaA/0AAa0aaaAAaaaa+AAAaaaaAA0AAAaAAA=;\r\n\tb=AA/a0a0Aa/A0aAa0aAAAAAaa0aAaaAaAA0AAaAAAAAaa0/Aa0aaAaAAAaAAAAAa0a0aA";

function encodedWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

// A whole message in the header order our server delivers: LMTP hop, our Authentication-Results,
// our Postfix hop, then what the sender wrote. The body is 8bit UTF-8 HTML.
export function buildAlertEmail(options: AlertEmailOptions = {}): string {
  const subject = options.subject ?? "Neue Treffer zu deiner Suche „RTX 4090 Synthetik“";
  const authenticationResults = options.authenticationResults ?? [AUTHENTICATION_RESULTS];
  const from = options.from ?? ["Kleinanzeigen <noreply@kleinanzeigen.de>"];
  const to = options.to ?? ["mailbox@example.invalid"];
  const headers = [
    "Return-Path: <bounces+0000000-0000-mailbox=example.invalid@em4286.kleinanzeigen.de>",
    "Delivered-To: mailbox@example.invalid",
    "Received: from mail.intra-ai.de\r\n\tby ubuntu with LMTP\r\n\tid 0AAAAAaA0AaAAaAAaaaAaa\r\n\tfor <mailbox@example.invalid>; Wed, 21 Oct 2026 12:54:47 +0200",
    ...authenticationResults.map((value) => `Authentication-Results: ${value}`),
    "Received: from o22.ptr2619.kleinanzeigen.de (o22.ptr2619.kleinanzeigen.de [192.0.2.10])\r\n\tby mail.intra-ai.de (Postfix) with ESMTPS id 0000AA0A00A\r\n\tfor <mailbox@example.invalid>; Wed, 21 Oct 2026 12:54:46 +0200 (CEST)",
    ...(options.senderHeaders ?? []),
    `DKIM-Signature: ${DKIM_SIGNATURE}`,
    "Received: from saved-search-application-fixture (ip-10-0-0-1.eu-central-1.compute.internal [10.0.0.1])\r\n\tby mailout-smtp-3.localdomain (Postfix) with ESMTP id 0A0AA00\r\n\tfor <mailbox@example.invalid>; Wed, 21 Oct 2026 10:54:44 +0000 (UTC)",
    "Date: Wed, 21 Oct 2026 10:54:45 +0000 (UTC)",
    ...from.map((value) => `From: ${value}`),
    "Message-ID: <1000000011.1.1792580000000@saved-search-application-fixture>",
    `Subject: ${encodedWord(subject)}`,
    "MIME-Version: 1.0",
    ...to.map((value) => `To: ${value}`),
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${buildAlertHtml(options).replace(/\r?\n/g, "\r\n")}`;
}

export function buildAlertHtml(options: AlertHtmlOptions = {}): string {
  const savedSearchId = options.savedSearchId ?? SAVED_SEARCH_ID;
  const savedSearchHref =
    options.savedSearchHref === undefined
      ? `https://www.kleinanzeigen.de/m-suche-verwenden.html?id=${savedSearchId}&amp;${UTM}&amp;utm_content=AllResults`
      : options.savedSearchHref;
  const savedSearchLink =
    savedSearchHref === null
      ? ""
      : `<a href="${savedSearchHref}" style="color:#1D4B00;line-height:130%;display:block;text-decoration:none;outline:0" title="Neue Treffer ansehen">Neue Treffer ansehen</a>`;
  const listings = (options.listings ?? [{}]).map((listing, index) => listingHtml(listing, index, savedSearchId));
  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
  <title>Neue Treffer</title>
  <style type="text/css">.t_w100p { width: 100% !important; } /* 320 € VB */</style>
</head>
<body style="background-color:#FFFFFF">
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="none"><tr><td>
  <a href="https://www.kleinanzeigen.de?utm_source=system_email&amp;utm_medium=email&amp;utm_content=Logo"><img src="https://static.kleinanzeigen.de/img/mail/logo-kleinanzeigen-boxed.png" alt="Kleinanzeigen" width="140"/></a>
</td></tr></table>
<table cellpadding="0" cellspacing="0" border="0" width="90%" align="center" role="none"><tr>
  <td style="font-size:24px;font-weight:700">Es gibt neue Anzeigen zu deinem Suchauftrag</td>
</tr><tr>
  <td style="text-align:center;height:44px;font-weight:700" class="t_c0c0c0b t_pt0px t_pb0px m_h44px" height="44">
    ${savedSearchLink}
  </td>
</tr></table>
${listings.join("\n")}
<table cellpadding="0" cellspacing="0" border="0" width="90%" align="center" style="margin:auto;clear:both" aria-hidden="true"><tr>
  <td style="height:32px;font-size:8px;vertical-align:bottom">&nbsp;</td>
</tr></table>
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="none"><tr><td style="text-align:center">
  <a href="https://www.kleinanzeigen.de/"><img src="https://static.kleinanzeigen.de/img/mail/footer/logo_ka_light.png" alt="Kleinanzeigen" width="120"/></a>
  <a href="https://www.facebook.com/Kleinanzeigen/"><img src="https://static.kleinanzeigen.de/img/mail/footer/icon-facebook.png" alt="Facebook" width="24"/></a>
  <p>Du erhältst diese E-Mail, weil du einen Suchauftrag gespeichert hast.</p>
  <p>Kleinanzeigen GmbH</p>
  <a href="https://www.kleinanzeigen.de/impressum.html?utm_source=system_email&amp;utm_medium=email&amp;utm_content=Other">Impressum</a>
</td></tr></table>
<img src="https://url2945.kleinanzeigen.de/wf/open?upn=FIXTURE" alt="" width="1" height="1" border="0" style="height:1px !important;width:1px !important"/>
</body>
</html>
`;
}
