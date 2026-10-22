// Zero-width and bidi control characters: soft hyphen, Mongolian vowel separator, zero-width
// space/non-joiner/joiner, LRM/RLM, the embeddings and overrides, word joiner and invisible
// operators, the isolates, Arabic letter mark and the BOM.
const HIDDEN = "­᠎​-‏‪-‮⁠-⁤⁦-⁩؜﻿";
const HIDDEN_ALL = new RegExp(`[${HIDDEN}]`, "g");
const HIDDEN_ANY = new RegExp(`[${HIDDEN}]`);

export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_ANY.test(text);
}

export function removeHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_ALL, "");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  euro: "€",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  deg: "°",
  times: "×",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  shy: "­",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Section 5.1 description cleaning without masking: script, style, iframe and noscript blocks
// and every tag dropped, entities decoded, zero-width and bidi characters removed, whitespace
// collapsed. The code scan reads this form; Claude gets it masked.
export function htmlToText(html: string): string {
  const withoutMarkup = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|iframe|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:script|style|iframe|noscript)\b[\s\S]*$/i, " ")
    .replace(/<[^>]*>/g, " ");
  // A NUL character cannot be stored in Postgres text.
  return collapseWhitespace(removeHiddenCharacters(decodeEntities(withoutMarkup)).replace(/\0/g, ""));
}

export const DESCRIPTION_HEAD_CHARS = 4500;
export const DESCRIPTION_TAIL_CHARS = 1500;
export const TRUNCATION_MARK = "[...]";

// Keeps the first `head` and last `tail` characters (code points, so no surrogate pair is split)
// with the truncation mark between.
export function truncateHeadTail(text: string, head: number, tail: number): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= head + tail) return { text, truncated: false };
  const kept = `${chars.slice(0, head).join("")} ${TRUNCATION_MARK} ${chars.slice(chars.length - tail).join("")}`;
  return { text: kept, truncated: true };
}

// Section 5.1: a title as sent to Claude (case kept, unlike the classifier's folded form).
export function cleanTitle(title: string): string {
  return maskContactData(collapseWhitespace(removeHiddenCharacters(title)));
}

// Section 5.1: the getItem description as sent to Claude. `truncated` sets description_truncated.
export function cleanDescription(html: string): { text: string; truncated: boolean } {
  return truncateHeadTail(maskContactData(htmlToText(html)), DESCRIPTION_HEAD_CHARS, DESCRIPTION_TAIL_CHARS);
}

const CONTACT_LINK = /(?<![\w.])(?:https?:\/\/)?(?:www\.)?(?:wa|t)\.me\/\S*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Section 5.1 IBAN pattern, plus a short last group (a German IBAN ends in a 2-character group).
export const IBAN_PATTERN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?:(?: ?[A-Z0-9]{1,3})(?![A-Za-z0-9]))?/g;
const PHONE_INTERNATIONAL = /(?:\+|(?<!\d)00)49[ /-]?(?:\(0\)[ /-]?)?\d{2,5}(?:[ /-]?\d{2,}){1,4}(?!\d)/g;
// A national number starts with 0 and has 6 or more digits in groups split by spaces, / or -.
const PHONE_NATIONAL = /(?<![\w.,])0\d{2,5}(?:[ /-]{0,3}\d{2,}){0,4}(?!\w)/g;
const MIN_PHONE_DIGITS = 6;

// Section 5.1: contact data becomes a placeholder before any text goes to Claude.
export function maskContactData(text: string): string {
  return text
    .replace(CONTACT_LINK, "[CONTACT_LINK]")
    .replace(EMAIL, "[EMAIL]")
    .replace(IBAN_PATTERN, "[IBAN]")
    .replace(PHONE_INTERNATIONAL, "[PHONE]")
    .replace(PHONE_NATIONAL, (m) => (m.replace(/\D/g, "").length >= MIN_PHONE_DIGITS ? "[PHONE]" : m));
}
