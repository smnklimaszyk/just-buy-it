export type HiddenCharacterKind =
  | "control"
  | "bidi_control"
  | "bidi_mark"
  | "zero_width"
  | "soft_hyphen"
  | "tag"
  | "variation_selector"
  | "other_invisible";

export type CleanedText = {
  text: string;
  truncated: boolean;
  hadHiddenCharacters: boolean;
  // Which kinds were removed, in the order first seen, each once.
  hiddenCharacterKinds: HiddenCharacterKind[];
};

// Removed: C0 and C1 controls except the whitespace ones (tab to carriage return), every format
// character (Cf: zero-width, bidi marks, overrides and isolates, soft hyphen, tag characters,
// invisible operators, the byte order mark) and every default-ignorable code point (variation
// selectors, Hangul fillers, the combining grapheme joiner). A mail client draws none of these, but
// a model reads them, so tag characters can carry a whole hidden sentence. The zero-width joiner
// goes too: it only splits emoji sequences such as a family into single emoji.
const HIDDEN = /(?![\t-\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

// Escapes only, so this file holds no invisible character itself.
const KINDS: readonly [RegExp, HiddenCharacterKind][] = [
  [/\p{Cc}/u, "control"],
  [/[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u, "bidi_control"],
  [/[\u{200E}\u{200F}\u{061C}]/u, "bidi_mark"],
  [/[\u{200B}-\u{200D}\u{2060}\u{FEFF}]/u, "zero_width"],
  [/\u{00AD}/u, "soft_hyphen"],
  [/[\u{E0000}-\u{E007F}]/u, "tag"],
  [/[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180D}\u{180F}]/u, "variation_selector"],
];

function kindOf(char: string): HiddenCharacterKind {
  return KINDS.find(([pattern]) => pattern.test(char))?.[1] ?? "other_invisible";
}

// Text from an email is data. The HTML parser has already decoded entities once, so this never
// decodes again: "&lt;" in the result is the literal text the sender wrote.
export function cleanText(input: string, maxChars: number): CleanedText {
  const characters = Array.from(input);
  const kinds = new Set<HiddenCharacterKind>();
  const visible = characters.filter((char) => {
    if (!HIDDEN.test(char)) return true;
    kinds.add(kindOf(char));
    return false;
  });
  // Normalize after removal: a hidden character between a letter and its combining mark blocks
  // composition, so normalizing first would leave "o" + U+0308 where "ö" is expected.
  const collapsed = visible.join("").normalize("NFC").replace(/\s+/gu, " ").trim();
  const codePoints = Array.from(collapsed);
  const truncated = codePoints.length > maxChars;
  return {
    text: truncated ? codePoints.slice(0, maxChars).join("").trimEnd() : collapsed,
    truncated,
    hadHiddenCharacters: kinds.size > 0,
    hiddenCharacterKinds: [...kinds],
  };
}
