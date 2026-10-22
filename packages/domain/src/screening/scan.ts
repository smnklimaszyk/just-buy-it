import { foldTitle } from "../classify/fold.js";
import {
  IBAN_PATTERN,
  decodeEntities,
  hasHiddenCharacters,
  htmlToText,
  maskContactData,
  removeHiddenCharacters,
} from "../text.js";

// Section 5.6 code signals, in output order. The first two are scam floors.
export const CODE_SIGNALS = [
  "iban_present",
  "off_ebay_payment_phrase",
  "payment_mention",
  "off_ebay_contact_phrase",
  "hidden_characters",
  "reviewer_directed_phrase",
] as const;
export type CodeSignal = (typeof CODE_SIGNALS)[number];

export type ScanInput = {
  title: string;
  // getItem description HTML, or null for a listing known only from its summary.
  descriptionHtml: string | null;
  // The listing offers shipping (not pickup only).
  shippingOffered: boolean;
};

const IBAN_MIN_LENGTH = 15;

// ISO 13616: the first four characters moved to the end, letters as 10 to 35, mod 97 equals 1.
function hasValidIbanCheckSum(iban: string): boolean {
  let remainder = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const value = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// The pattern may take a short group that is not part of the IBAN, so shorter prefixes are tried too.
function containsValidIban(text: string): boolean {
  for (const match of text.matchAll(IBAN_PATTERN)) {
    const compact = match[0].replace(/ /g, "");
    for (let length = compact.length; length >= IBAN_MIN_LENGTH; length -= 1) {
      if (hasValidIbanCheckSum(compact.slice(0, length))) return true;
    }
  }
  return false;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

const OFF_EBAY_PAYMENT = new RegExp(
  `${B}(?:paypal freunde(?: (?:und|&) familie)?|paypal friends(?: (?:and|&) family)?|freunde (?:und|&) familie|friends (?:and|&) family|western union|moneygram|vorkasse per überweisung|direkt überweisen|zahlung au(?:ß|ss)erhalb|nicht über ebay|ohne ebay)${E}`,
  "gu",
);
const CASH_ON_PICKUP = new RegExp(`${B}bar bei abholung${E}`, "gu");
// A payment phrase the seller rules out is no request: "kein Western Union", "PayPal Freunde
// nicht möglich". The negation must stand right next to the phrase, so "Kein Problem, PayPal
// Freunde" still counts.
const NEGATION_BEFORE = new RegExp(
  `${B}(?:kein|keine|keinen|no|never)(?: (?:zahlung|bezahlung|payment))?(?: (?:per|via|mit|über|by))?[^\\p{L}\\p{N}]*$`,
  "u",
);
const NEGATION_AFTER = new RegExp(
  `^[^\\p{L}\\p{N}]*(?:(?:ist|sind|wird|werden|is|are) )?(?:leider |sorry )?(?:(?:nicht|not|nie|never) (?:möglich|akzeptiert|accepted|possible|erwünscht|gewünscht|angeboten|offered)|ausgeschlossen)${E}`,
  "u",
);

// True when some match of the phrase is not ruled out by a negation in its sentence.
function requested(text: string, phrase: RegExp): boolean {
  for (const match of text.matchAll(phrase)) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    if (!NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after)) return true;
  }
  return false;
}

const PAYMENT_MENTION = new RegExp(`${B}(?:überweisung|vorkasse)`, "u");
const CONTACT_PHRASE = new RegExp(
  `${B}(?:melde dich|schreib mir|whatsapp|telegram|ruf an|kontakt au(?:ß|ss)erhalb)${E}`,
  "u",
);
const REVIEWER_DIRECTED = new RegExp(`${B}(?:ignore previous|ki|ai assistant|chatgpt|claude|as an ai)${E}`, "u");
const CONTACT_PLACEHOLDER = /\[(?:PHONE|EMAIL|CONTACT_LINK)\]/g;

// Contact data is what the masking would replace: phone numbers, email addresses, wa.me and t.me links.
function hasContactData(text: string): boolean {
  const before = text.match(CONTACT_PLACEHOLDER)?.length ?? 0;
  return (maskContactData(text).match(CONTACT_PLACEHOLDER)?.length ?? 0) > before;
}

function hasHiddenText(input: ScanInput): boolean {
  const html = input.descriptionHtml ?? "";
  return hasHiddenCharacters(input.title) || hasHiddenCharacters(html) || hasHiddenCharacters(decodeEntities(html));
}

// Runs on the title and the description before masking (section 5.6).
export function scanListing(input: ScanInput): CodeSignal[] {
  const description = input.descriptionHtml === null ? "" : htmlToText(input.descriptionHtml);
  const plain = `${removeHiddenCharacters(input.title)}\n${description}`;
  const folded = `${foldTitle(input.title)} \n ${foldTitle(description)}`;
  const offEbayPayment = requested(folded, OFF_EBAY_PAYMENT);
  // eBay.de offers cash on pickup itself, so with shipping offered it is worth a check, not a block.
  const cashOnPickup = input.shippingOffered && requested(folded, CASH_ON_PICKUP);
  const on: Record<CodeSignal, boolean> = {
    iban_present: containsValidIban(plain),
    off_ebay_payment_phrase: offEbayPayment,
    // A bank transfer named without an off-platform phrase is worth a check, not a block.
    payment_mention: !offEbayPayment && (PAYMENT_MENTION.test(folded) || cashOnPickup),
    // A phrase alone, or contact data alone (a seller's legal notice), is no signal.
    off_ebay_contact_phrase: CONTACT_PHRASE.test(folded) && hasContactData(plain),
    hidden_characters: hasHiddenText(input),
    reviewer_directed_phrase: REVIEWER_DIRECTED.test(folded),
  };
  return CODE_SIGNALS.filter((s) => on[s]);
}
