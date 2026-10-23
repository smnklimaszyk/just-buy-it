import { foldTitle } from "../classify/fold.js";

// Section 3.2. The four word lists of a product and the grammar of their entries.
export type EntryList = "search" | "must" | "warn" | "exclude";

export const MAX_ENTRY_CHARS = 40;

const SEARCH_WORD = /^[\p{L}\p{N}]+$/u;
const PHRASE = /^[\p{L}\p{N}]+( [\p{L}\p{N}]+){0,3}\*?$/u;
const EXCLUDE_PHRASE = /^~?[\p{L}\p{N}]+( [\p{L}\p{N}]+){0,3}\*?$/u;

const GRAMMAR: Record<EntryList, { pattern: RegExp; error: string }> = {
  search: { pattern: SEARCH_WORD, error: "Use one word of letters and digits." },
  must: { pattern: PHRASE, error: "Use up to four words of letters and digits; a * may end the entry." },
  warn: { pattern: PHRASE, error: "Use up to four words of letters and digits; a * may end the entry." },
  exclude: {
    pattern: EXCLUDE_PHRASE,
    error: "Use up to four words of letters and digits; a ~ may start the entry and a * may end it.",
  },
};

export type EntryCheck = { ok: true; folded: string } | { ok: false; error: string };

// Entries are folded like titles (NFKC, lower case, hidden characters removed, - _ / | + as
// spaces), so "E-Bike" is stored as "e bike" and compared with the folded title.
export function foldEntry(raw: string): string {
  return foldTitle(raw);
}

// The check behind the product form's field errors. The length is counted in characters of the
// folded entry, before the pattern runs, so no pattern ever sees more than 40 characters.
export function checkWordEntry(list: EntryList, raw: string): EntryCheck {
  const folded = foldEntry(raw);
  if (folded === "") return { ok: false, error: "Enter a word." };
  if ([...folded].length > MAX_ENTRY_CHARS) return { ok: false, error: `Use at most ${MAX_ENTRY_CHARS} characters.` };
  const { pattern, error } = GRAMMAR[list];
  return pattern.test(folded) ? { ok: true, folded } : { ok: false, error };
}

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/u;

// Section 3.3: the folded title split on anything that is not a letter or digit. The
// multiplication sign becomes the token "x", so "2×16GB" reads like "2 x 16gb".
export function tokenize(title: string): string[] {
  return foldTitle(title)
    .replaceAll("×", " x ")
    .split(NOT_LETTER_OR_DIGIT)
    .filter((token) => token !== "");
}

// A stored entry as the matcher reads it: `~` in front makes it negatable, `*` at the end makes
// its last token a prefix. The tokens are split on spaces only, so text that never passed the
// grammar keeps its other characters and can never equal a title token.
export type Entry = {
  text: string;
  tokens: readonly string[];
  prefix: boolean;
  negatable: boolean;
};

export function parseEntry(raw: string): Entry {
  const text = foldEntry(raw);
  const negatable = text.startsWith("~");
  const prefix = text.endsWith("*") && text.length > (negatable ? 2 : 1);
  const body = text.slice(negatable ? 1 : 0, prefix ? -1 : undefined).trim();
  return { text, tokens: body === "" ? [] : body.split(" "), prefix, negatable };
}

// True when the entry's tokens stand at `at` and after it: equal, or for the last token of a
// prefix entry, the start of the title token.
export function entryMatchesAt(tokens: readonly string[], at: number, entry: Entry): boolean {
  const count = entry.tokens.length;
  if (count === 0 || at + count > tokens.length) return false;
  for (let i = 0; i < count; i++) {
    const wanted = entry.tokens[i] ?? "";
    const token = tokens[at + i] ?? "";
    const last = i === count - 1;
    if (last && entry.prefix ? !token.startsWith(wanted) : token !== wanted) return false;
  }
  return true;
}

const NEGATIONS = ["nicht", "kein*", "keine*", "ohne", "non", "no", "not", "frei"].map(parseEntry);
const NEGATION_REACH = 2;

// Section 3.3: a hit at `at` is negated when a negation word stands within the two tokens
// before it ("keine Kratzer", "ohne grosse Kratzer", "non stop").
export function isNegatedAt(tokens: readonly string[], at: number): boolean {
  for (let back = 1; back <= NEGATION_REACH; back++) {
    const before = at - back;
    if (before >= 0 && NEGATIONS.some((negation) => entryMatchesAt(tokens, before, negation))) return true;
  }
  return false;
}

// Every token position at which the entry matches.
export function entryHits(tokens: readonly string[], entry: Entry): number[] {
  const hits: number[] = [];
  for (let at = 0; at < tokens.length; at++) {
    if (entryMatchesAt(tokens, at, entry)) hits.push(at);
  }
  return hits;
}
