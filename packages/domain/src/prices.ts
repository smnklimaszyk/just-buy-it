// How the MVP's segment rules priced: per item, or per GB.
type RuleKind = "per_item" | "per_gb";

// Section 3.5: the price read over app.price_sample rows of one segment and window.
export type PriceSampleInput = { landedCents: number | null; totalGb: number | null };

export type PriceStatistics = {
  // Rows with a known landed price.
  n: number;
  // Quartiles of the landed price in cents; per-GB segments: cents per GB.
  p25: number | null;
  p50: number | null;
  p75: number | null;
  // p75 of the landed total in cents, for the read-ceiling check.
  landedP75: number | null;
};

// Linear interpolation between the closest ranks (the common "type 7" definition).
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lo = sorted[lower] ?? 0;
  const hi = sorted[upper] ?? 0;
  return lo + (hi - lo) * (rank - lower);
}

export const MIN_SAMPLES_FOR_SUGGESTION = 20;
// A read whose p75 reaches 90% of the feed's read ceiling is cut off by the poll's price filter.
const CUT_OFF_SHARE = 0.9;

export type RuleSuggestion =
  | { kind: "per_item"; maxLandedCents: number; floorCents: number }
  | { kind: "per_gb"; maxCentsPerGb: number; minCentsPerGb: number }
  | { kind: "none"; reason: "too_few" | "cut_off" };

// Rounds down to the step (EUR 10 per item, EUR 0.10 per GB). The small allowance keeps a value
// like 0.4 x 65000 = 25999.999... from dropping a whole step.
const roundDown = (value: number, step: number): number => Math.floor(value / step + 1e-9) * step;

// Section 3.5: max = min(p25, 0.8 x p50), floor = 0.4 x p50, both rounded down.
export function suggestRule(stats: PriceStatistics, kind: RuleKind, readCeilingCents: number): RuleSuggestion {
  if (stats.n < MIN_SAMPLES_FOR_SUGGESTION || stats.p25 === null || stats.p50 === null) {
    return { kind: "none", reason: "too_few" };
  }
  if (stats.landedP75 !== null && stats.landedP75 >= CUT_OFF_SHARE * readCeilingCents) {
    return { kind: "none", reason: "cut_off" };
  }
  const step = kind === "per_item" ? 1000 : 10;
  const max = roundDown(Math.min(stats.p25, 0.8 * stats.p50), step);
  const floor = roundDown(0.4 * stats.p50, step);
  return kind === "per_item"
    ? { kind, maxLandedCents: max, floorCents: floor }
    : { kind, maxCentsPerGb: max, minCentsPerGb: floor };
}

export function priceStatistics(rows: readonly PriceSampleInput[], kind: RuleKind): PriceStatistics {
  const known = rows.filter(
    (r): r is { landedCents: number; totalGb: number | null } =>
      r.landedCents !== null && (kind === "per_item" || (r.totalGb !== null && r.totalGb > 0)),
  );
  const values = known.map((r) => (kind === "per_gb" && r.totalGb !== null ? r.landedCents / r.totalGb : r.landedCents));
  const sorted = [...values].sort((a, b) => a - b);
  const landed = known.map((r) => r.landedCents).sort((a, b) => a - b);
  return {
    n: known.length,
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    landedP75: percentile(landed, 0.75),
  };
}
