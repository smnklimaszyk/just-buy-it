import PostalMime, { type Email } from "postal-mime";
import { checkAuthentication, checkRecipient, checkSender, matchSubject, type AuthenticationDetail, type RecipientDetail, type SenderDetail } from "./headers.js";
import { extractListings, type KleinanzeigenListing, type ListingsRejectDetail } from "./listings.js";

export type { KleinanzeigenListing, SellerType } from "./listings.js";
export type { KleinanzeigenPrice, PriceKind } from "./price.js";
export type { HiddenCharacterKind } from "./text.js";

export const DEFAULT_TRUSTED_AUTHSERV_ID = "mail.intra-ai.de";
export const MAX_LABEL_CHARS = 200;
// The real alerts are about 59 KB.
export const MAX_RAW_BYTES = 1_048_576;
const MAX_MESSAGE_ID_CHARS = 300;

// An alert is one HTML part; anything far beyond that is not one. An attached message stays an
// attachment: postal-mime would otherwise render it into the HTML, headers included, and nested ones
// made a 570 KB message need more than the worker's 160 MB heap, before any check had run.
const MIME_LIMITS = { maxNestingDepth: 8, maxPartCount: 32, maxHeadersSize: 65_536, maxRfc822NestingDepth: 0 };

// expectedRecipient has no default: the caller passes the alert mailbox address. It stops a replay
// of a genuine alert that Kleinanzeigen sent to someone else's account (its signed To is not ours).
export type ParseAlertOptions = { expectedRecipient: string; trustedAuthservId?: string };

export type ParsedAlert = {
  ok: true;
  messageId: string;
  // The Date header, which DKIM signs; the mailbox's INTERNALDATE is the receive time.
  sentAt: Date;
  savedSearchId: string;
  savedSearchLabel: string;
  listings: KleinanzeigenListing[];
};

export type AlertRejectReason =
  | "not_authenticated"
  | "wrong_sender"
  | "wrong_recipient"
  | "not_saved_search"
  | "no_listings"
  | "malformed";

export type AlertRejectDetail =
  | AuthenticationDetail
  | SenderDetail
  | RecipientDetail
  | "subject_mismatch"
  | "no_listing_links"
  | ListingsRejectDetail
  | "too_large"
  | "mime_parse_failed"
  | "missing_message_id"
  | "missing_date"
  | "no_html";

// Only the two codes, never a header value or body text, so a rejection is safe to log.
export type RejectedAlert = { ok: false; reason: AlertRejectReason; detail: AlertRejectDetail };

export type AlertParseResult = ParsedAlert | RejectedAlert;

// Never throws: an exception from postal-mime, parse5 or a helper of theirs becomes malformed.
// A rejection carries the two codes only, so nothing from the message reaches a log line.
export async function parseAlertEmail(raw: Buffer | string, options: ParseAlertOptions): Promise<AlertParseResult> {
  const size = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.length;
  if (size > MAX_RAW_BYTES) return { ok: false, reason: "malformed", detail: "too_large" };
  try {
    const email = await PostalMime.parse(raw, MIME_LIMITS);
    // postal-mime reads any line as a header, even one without a colon; a real header name is
    // printable ASCII without a colon (RFC 5322 section 2.2).
    if (email.headers.length === 0 || email.headers.some((header) => !/^[!-9;-~]+$/.test(header.key))) {
      return { ok: false, reason: "malformed", detail: "mime_parse_failed" };
    }
    return readAlert(email, options);
  } catch {
    return { ok: false, reason: "malformed", detail: "mime_parse_failed" };
  }
}

// The checks in order; the first failure is the result.
function readAlert(email: Email, options: ParseAlertOptions): AlertParseResult {
  const authentication = checkAuthentication(email.headers, options.trustedAuthservId ?? DEFAULT_TRUSTED_AUTHSERV_ID);
  if (!authentication.ok) return { ok: false, reason: "not_authenticated", detail: authentication.detail };
  // dkim=pass for kleinanzeigen.de plus this From is DMARC alignment.
  const sender = checkSender(email.headers);
  if (!sender.ok) return { ok: false, reason: "wrong_sender", detail: sender.detail };
  const recipient = checkRecipient(email.headers, options.expectedRecipient);
  if (!recipient.ok) return { ok: false, reason: "wrong_recipient", detail: recipient.detail };
  const subject = matchSubject(email.headers, email.subject, MAX_LABEL_CHARS);
  if (!subject.ok) return { ok: false, reason: "not_saved_search", detail: "subject_mismatch" };
  const messageId = (email.messageId ?? "").trim().replace(/^<|>$/g, "");
  if (messageId === "" || messageId.length > MAX_MESSAGE_ID_CHARS) {
    return { ok: false, reason: "malformed", detail: "missing_message_id" };
  }
  const sentAt = new Date(email.date ?? "");
  if (Number.isNaN(sentAt.getTime())) return { ok: false, reason: "malformed", detail: "missing_date" };
  if (email.html === undefined || email.html.trim() === "") return { ok: false, reason: "malformed", detail: "no_html" };
  const extracted = extractListings(email.html);
  if (!extracted.ok) return extracted;
  return {
    ok: true,
    messageId,
    sentAt,
    savedSearchId: extracted.savedSearchId,
    savedSearchLabel: subject.label,
    listings: extracted.listings,
  };
}
