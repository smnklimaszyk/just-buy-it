import { addressParser } from "postal-mime";
import { cleanText } from "./text.js";

// A header as postal-mime gives it: lower-case key, value unfolded but otherwise as sent.
export type EmailHeader = { key: string; value: string };

export type AuthenticationDetail =
  | "no_authentication_results"
  | "below_trusted_hop"
  | "foreign_authserv_id"
  | "dkim_not_pass"
  | "dkim_length_tag"
  | "dkim_headers_not_signed";

const SIGNING_DOMAIN = "kleinanzeigen.de";
const SIGNED_HEADERS = ["from", "to", "subject", "date"];

export type HeaderCheck<Detail> = { ok: true } | { ok: false; detail: Detail };

// Drops RFC 5322 comments, which may nest and may hold a quoted pair such as "\)". One pass, no
// regex, so a long or unbalanced value costs linear time; an unclosed comment runs to the end.
function stripComments(value: string): string {
  let depth = 0;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (depth > 0 && char === "\\") i++;
    else if (char === "(") depth++;
    else if (depth > 0 && char === ")") depth--;
    else if (depth === 0) out += char;
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export function checkAuthentication(
  headers: readonly EmailHeader[],
  trustedAuthservId: string,
): HeaderCheck<AuthenticationDetail> {
  const arIndex = headers.findIndex((header) => header.key === "authentication-results");
  if (arIndex === -1) return { ok: false, detail: "no_authentication_results" };
  const [authservPart = "", ...results] = stripComments(headers[arIndex]?.value ?? "").split(";");
  // authserv-id, optionally followed by a version number (RFC 8601 section 2.2).
  const [authservId = "", ...rest] = authservPart.trim().split(/\s+/);
  const versionOnly = rest.length === 0 || (rest.length === 1 && /^\d{1,9}$/.test(rest[0] ?? ""));
  if (authservId.toLowerCase() !== trustedAuthservId.toLowerCase() || !versionOnly) {
    return { ok: false, detail: "foreign_authserv_id" };
  }
  // Our Postfix adds the topmost "Received: ... by <our server>" line; everything the sender wrote,
  // including a forged Authentication-Results header, sits below it.
  const ourHop = new RegExp(`\\bby\\s+${escapeRegExp(trustedAuthservId)}[\\s;(]`, "i");
  const hopIndex = headers.findIndex((header) => header.key === "received" && ourHop.test(header.value));
  if (hopIndex === -1 || arIndex > hopIndex) return { ok: false, detail: "below_trusted_hop" };
  // The header.b value of each passing result, or undefined when it has none.
  const passingSignatures: (string | undefined)[] = [];
  for (const result of results) {
    const [method = "", ...properties] = result.trim().split(/\s+/);
    // Exactly one header.d, so a result naming two domains never counts for either.
    const domains = properties.filter((p) => p.toLowerCase().startsWith("header.d="));
    if (method.toLowerCase() !== "dkim=pass" || domains.length !== 1) continue;
    if (domains[0]?.toLowerCase() !== `header.d=${SIGNING_DOMAIN}`) continue;
    passingSignatures.push(properties.find((p) => p.toLowerCase().startsWith("header.b="))?.slice("header.b=".length));
  }
  if (passingSignatures.length === 0) return { ok: false, detail: "dkim_not_pass" };
  // header.b is the start of the b= value of the signature that passed (RFC 6008).
  const passed = (b: string) => passingSignatures.some((prefix) => prefix === undefined || b.startsWith(prefix));
  const signatures = headers
    .filter((header) => header.key === "dkim-signature")
    .map((header) => dkimTags(header.value))
    .filter((tags) => tags.get("d")?.toLowerCase() === SIGNING_DOMAIN && passed(tags.get("b") ?? ""));
  // A length tag signs only the first l bytes of the body, so anyone could append to it.
  if (signatures.some((tags) => tags.has("l"))) return { ok: false, detail: "dkim_length_tag" };
  // The checks on From, To, Subject and Date below prove something only if the signature covers them.
  const unsigned = signatures.some((tags) => {
    const signed = (tags.get("h") ?? "").toLowerCase().split(":");
    return SIGNED_HEADERS.some((name) => !signed.includes(name));
  });
  if (signatures.length === 0 || unsigned) return { ok: false, detail: "dkim_headers_not_signed" };
  return { ok: true };
}

export type SenderDetail = "from_missing" | "from_not_single" | "from_address";

const SENDER = "noreply@kleinanzeigen.de";

// The address of the one mailbox in a From or To value, lower-cased; null for a group, a display
// name alone, or more than one address.
function singleAddress(value: string): string | null {
  const addresses = addressParser(value);
  const [first] = addresses;
  if (addresses.length !== 1 || first === undefined || first.group !== undefined || first.address === "") return null;
  return first.address.toLowerCase();
}

export function checkSender(headers: readonly EmailHeader[]): HeaderCheck<SenderDetail> {
  const from = headers.filter((header) => header.key === "from");
  if (from.length === 0) return { ok: false, detail: "from_missing" };
  if (from.length > 1) return { ok: false, detail: "from_not_single" };
  if (singleAddress(from[0]?.value ?? "") !== SENDER) return { ok: false, detail: "from_address" };
  return { ok: true };
}

export type RecipientDetail = "to_missing" | "to_not_single" | "to_address";

// A genuine alert that Kleinanzeigen sent to another account carries a valid signature too; its
// signed To names that account, not ours.
export function checkRecipient(headers: readonly EmailHeader[], expectedRecipient: string): HeaderCheck<RecipientDetail> {
  const to = headers.filter((header) => header.key === "to");
  if (to.length === 0) return { ok: false, detail: "to_missing" };
  if (to.length > 1) return { ok: false, detail: "to_not_single" };
  if (singleAddress(to[0]?.value ?? "") !== expectedRecipient.toLowerCase()) return { ok: false, detail: "to_address" };
  return { ok: true };
}

export type SubjectMatch = { ok: true; label: string } | { ok: false };

const ALERT_SUBJECT = /^Neue Treffer zu deiner Suche „(.+)“$/u;

// `subject` is the decoded Subject (postal-mime's email.subject).
export function matchSubject(headers: readonly EmailHeader[], subject: string | undefined, maxLabelChars: number): SubjectMatch {
  if (headers.filter((header) => header.key === "subject").length !== 1) return { ok: false };
  // No cut here (a string never has more code points than code units); the label is capped below.
  const cleaned = cleanText(subject ?? "", (subject ?? "").length).text;
  const match = ALERT_SUBJECT.exec(cleaned);
  const label = cleanText(match?.[1] ?? "", maxLabelChars).text;
  if (label === "") return { ok: false };
  return { ok: true, label };
}

// DKIM-Signature tag list (RFC 6376 section 3.2): "name=value" pairs split by ";", folding
// whitespace inside a value carries no meaning.
function dkimTags(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const pair of value.split(";")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    tags.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).replace(/\s+/g, ""));
  }
  return tags;
}
