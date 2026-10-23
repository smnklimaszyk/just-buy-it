import { entryHits, entryMatchesAt, isNegatedAt, parseEntry, type Entry } from "./entries.js";

export const JUNK_REASONS = ["wanted_ad", "rental", "defective", "box_or_picture_only", "bundle"] as const;
export type JunkReason = (typeof JUNK_REASONS)[number];

// One marketplace rule. `entries` use the word grammar of section 3.2; a hit does not count
// when `unlessNegated` is set and a negation word stands just before it, or when one of the
// `allow` entries matches at the same place ("defektfrei" for "defekt*").
export type JunkRule = {
  id: string;
  entries: readonly string[];
  reason: JunkReason;
  unlessNegated: boolean;
  allow: readonly string[];
};

// Section 3.3: German and English marketplace words that mark a listing as no offer of the
// product, whatever the product is. Changed by pull request only; a product can turn single
// rules off with `junk_exceptions`.
export const DEFAULT_JUNK_RULES: readonly JunkRule[] = [
  {
    id: "wanted",
    entries: ["suche", "gesucht", "wtb", "ankauf", "kaufe"],
    reason: "wanted_ad",
    unlessNegated: false,
    allow: [],
  },
  {
    id: "rental",
    entries: ["miete", "mieten", "vermiet*", "leihe", "verleih*", "rent", "rental"],
    reason: "rental",
    unlessNegated: false,
    allow: [],
  },
  {
    id: "defect",
    entries: [
      "defekt*",
      "kaputt*",
      "bastler*",
      "for parts",
      "ersatzteil*",
      "ohne funktion",
      "funktioniert nicht",
      "not working",
      "broken",
      "no signal",
      "kein bild",
      "artefakt*",
      "artifacts",
      "beschädigt*",
      "damaged",
    ],
    reason: "defective",
    unlessNegated: true,
    allow: ["defektfrei", "artefaktfrei"],
  },
  {
    id: "box_only",
    entries: [
      "nur ovp",
      "nur die ovp",
      "nur verpackung",
      "nur die verpackung",
      "nur karton",
      "nur box",
      "ovp only",
      "box only",
      "ovp ohne inhalt",
      "verpackung ohne inhalt",
      "karton ohne inhalt",
      "box ohne inhalt",
      "leere ovp",
      "leere verpackung",
      "leerer karton",
      "leeren karton",
      "leere box",
      "empty box",
      "nur bild",
      "nur bilder",
      "nur foto",
      "nur fotos",
      "photo of",
    ],
    reason: "box_or_picture_only",
    unlessNegated: true,
    allow: [],
  },
  {
    id: "bundle",
    entries: ["konvolut*", "bundle of", "lot of"],
    reason: "bundle",
    unlessNegated: false,
    allow: [],
  },
];

export function isJunkRuleId(id: string): boolean {
  return DEFAULT_JUNK_RULES.some((rule) => rule.id === id);
}

type ParsedRule = { id: string; reason: JunkReason; unlessNegated: boolean; entries: Entry[]; allow: Entry[] };

const PARSED: readonly ParsedRule[] = DEFAULT_JUNK_RULES.map((rule) => ({
  id: rule.id,
  reason: rule.reason,
  unlessNegated: rule.unlessNegated,
  entries: rule.entries.map(parseEntry),
  allow: rule.allow.map(parseEntry),
}));

function fires(rule: ParsedRule, tokens: readonly string[]): boolean {
  return rule.entries.some((entry) =>
    entryHits(tokens, entry).some(
      (at) =>
        !(rule.unlessNegated && isNegatedAt(tokens, at)) && !rule.allow.some((allowed) => entryMatchesAt(tokens, at, allowed)),
    ),
  );
}

// Step 2 of section 3.4 on each token run (title, condition text, condition description),
// rules in order, minus the product's exceptions. Runs are checked one by one, so an entry
// never spans two fields.
export function junkReason(runs: readonly (readonly string[])[], exceptions: readonly string[]): JunkReason | null {
  for (const rule of PARSED) {
    if (exceptions.includes(rule.id)) continue;
    if (runs.some((tokens) => fires(rule, tokens))) return rule.reason;
  }
  return null;
}
