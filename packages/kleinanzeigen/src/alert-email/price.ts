export type PriceKind = "fixed" | "negotiable" | "negotiable_no_price" | "free" | "unknown";

export type KleinanzeigenPrice = { kind: PriceKind; cents: number | null };

const PRICE = /^(\d{1,3}(?:\.\d{3})+|\d{1,7})(?:,(\d{2}))?\s?€(?:\s?(VB))?$/u;

const MAX_EURO_DIGITS = 7;
const MAX_CENTS = 100_000_000;

const UNKNOWN: KleinanzeigenPrice = { kind: "unknown", cents: null };

// Reads the price text of one listing as Kleinanzeigen prints it ("2.450 € VB", "1.234,50 €").
// Integer arithmetic only; the digit count is checked first so the sum stays a safe integer.
export function parsePrice(text: string): KleinanzeigenPrice {
  const lower = text.toLowerCase();
  if (lower === "zu verschenken") return { kind: "free", cents: 0 };
  if (lower === "vb") return { kind: "negotiable_no_price", cents: null };
  const match = PRICE.exec(text);
  if (match === null) return UNKNOWN;
  const euroDigits = (match[1] ?? "").replaceAll(".", "");
  if (euroDigits.length > MAX_EURO_DIGITS) return UNKNOWN;
  const cents = Number.parseInt(euroDigits, 10) * 100 + Number.parseInt(match[2] ?? "0", 10);
  if (cents > MAX_CENTS) return UNKNOWN;
  return { kind: match[3] === undefined ? "fixed" : "negotiable", cents };
}
