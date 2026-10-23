import type { StoredMarketValue, StoredProduct } from "@ebay-sniper/db";
import { resolveLimit, type ConditionGroup, type MarketValueRef } from "@ebay-sniper/domain";
import { Button, Icon } from "../../ui/core.js";
import { DescriptionList } from "../../ui/data.js";
import { Badge, Callout } from "../../ui/feedback.js";
import { T } from "../../ui/shared.js";
import { formatDay, formatPrice, formatStamp, outcomeLabel } from "./format.js";
import type { CheckedListing, RefusedCheckInfo, TrendPoint } from "./queries.js";
import { GROUP_LABEL, MarketBadge, watchedGroups } from "./list-view.js";

// Spec 6.5: per watched condition group the typical asking price, the limit it gives, how sure it
// is and the details, with the time it was computed (eBay licence 8.1(c)).

export type MarketData = {
  // The newest value per group of the current match version, any status.
  values: StoredMarketValue[];
  // The newest ok value per group, which the limit uses (spec 6.4).
  ok: MarketValueRef[];
  // A market check is asked for and not done yet.
  checking: boolean;
  // The newest check ended without a snapshot.
  refused: RefusedCheckInfo | null;
  // The titles of the newest check, for 6 hours.
  listings: CheckedListing[];
  // The values of the last 30 days, oldest first, for the trend line.
  trend: TrendPoint[];
};

// The trend's drawing area in SVG units; the CSS scales it to the box.
const TREND_W = 300;
const TREND_H = 80;
const TREND_PAD = 4;

// Spec 6.5: a line of the typical asking price over 30 days with the middle half (p25 - p75) as a
// band. Each point has a title, so a pointer shows its day and value without script.
function MarketTrend({ label, points, unit }: { label: string; points: TrendPoint[]; unit: string }) {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || points.length < 2) return null;
  const low = Math.min(...points.map((p) => p.p25Cents ?? p.mCents));
  const high = Math.max(...points.map((p) => p.p75Cents ?? p.mCents));
  const start = first.computedAt.getTime();
  const span = Math.max(last.computedAt.getTime() - start, 1);
  const x = (at: Date) => (TREND_PAD + ((at.getTime() - start) / span) * (TREND_W - 2 * TREND_PAD)).toFixed(1);
  const y = (cents: number) => (TREND_H - TREND_PAD - ((cents - low) / Math.max(high - low, 1)) * (TREND_H - 2 * TREND_PAD)).toFixed(1);
  const top = points.map((p) => `${x(p.computedAt)},${y(p.p75Cents ?? p.mCents)}`);
  const bottom = points.map((p) => `${x(p.computedAt)},${y(p.p25Cents ?? p.mCents)}`).reverse();
  const middle = (p: TrendPoint) =>
    p.p25Cents === null || p.p75Cents === null ? "" : `, middle half ${formatPrice(p.p25Cents)} - ${formatPrice(p.p75Cents)}${unit}`;
  return (
    <svg
      class="app-trend"
      viewBox={`0 0 ${String(TREND_W)} ${String(TREND_H)}`}
      role="img"
      aria-label={`${label}: typical asking price over the last 30 days, from ${formatPrice(first.mCents)}${unit} to ${formatPrice(last.mCents)}${unit}`}
    >
      <polygon class="app-trend__band" points={[...top, ...bottom].join(" ")} />
      <polyline class="app-trend__line" points={points.map((p) => `${x(p.computedAt)},${y(p.mCents)}`).join(" ")} />
      {points.map((p) => (
        <circle class="app-trend__point" cx={x(p.computedAt)} cy={y(p.mCents)} r="4">
          <title>{`${formatDay(p.computedAt)}: ${formatPrice(p.mCents)}${unit}${middle(p)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

const COUNT_LABEL: Record<string, (n: number) => string> = {
  too_cheap: () => "too cheap",
  outlier: (n) => (n === 1 ? "outlier" : "outliers"),
  unknown_shipping: () => "unknown shipping",
  wrong_product: () => "wrong product",
};

const percent = (share: number): string => `${String(Math.round(share * 100))} %`;

// "Middle half EUR 560 - EUR 680; precision +/- 6 %; ..." in the order of spec 6.5.
function details(value: StoredMarketValue, unit: string): string {
  const parts: string[] = [];
  if (value.p25Cents !== null && value.p75Cents !== null) parts.push(`Middle half ${formatPrice(value.p25Cents)} - ${formatPrice(value.p75Cents)}${unit}`);
  if (value.halfWidth !== null) parts.push(`precision +/- ${percent(value.halfWidth)}`);
  parts.push(`effective count ${String(Math.round(value.neff))}`);
  if (value.bestOfferShare !== null) parts.push(`${percent(value.bestOfferShare)} Best Offer`);
  // Spec 6.5 names them in this order: too cheap, outlier, unknown shipping, wrong product.
  const removed = [
    ...Object.entries(COUNT_LABEL).flatMap(([reason, label]) => {
      const n = value.counts[reason];
      return n === undefined ? [] : [`${String(n)} ${label(n)}`];
    }),
    ...Object.entries(value.counts)
      .filter(([reason]) => COUNT_LABEL[reason] === undefined)
      .map(([reason, n]) => `${String(n)} ${reason.replaceAll("_", " ")}`),
  ];
  if (removed.length > 0) parts.push(`removed ${removed.join(", ")}`);
  if (value.capped) parts.push("newest listings only (snapshot capped)");
  return parts.join("; ");
}

function GroupValue({ product, group, market, now }: { product: StoredProduct; group: ConditionGroup; market: MarketData; now: Date }) {
  const { rules } = product;
  const unit = rules.perGb ? " per GB" : "";
  const label = GROUP_LABEL[group];
  const value = market.values.find((v) => v.conditionGroup === group && v.valueCents !== null);
  const limit = resolveLimit({ ...rules, matchVersion: product.matchVersion }, group, market.ok, now);
  // Spec 6.5: in fixed mode the max as a share of the typical asking price.
  const share = value?.valueCents ? `your max is ${String(Math.round((rules.maxCents / value.valueCents) * 100))} % of the typical asking price` : "your max";
  const limitText =
    rules.priceMode === "fixed"
      ? share
      : limit.usingCap
        ? "using your cap"
        : `${String(rules.belowMarketPct)} % below, never above ${formatPrice(rules.maxCents)}${unit}`;
  const list = (
    <DescriptionList
      items={[
        {
          label: `${label}: typical asking price`,
          value:
            value === undefined ? (
              "No value yet"
            ) : (
              <>
                {formatPrice(value.valueCents ?? 0)}
                {unit} <span>from {String(value.n)} listings, {formatStamp(value.computedAt)}</span>
              </>
            ),
          numeric: true,
        },
        {
          label: `Your limit for ${label.toLowerCase()}`,
          value: (
            <>
              {formatPrice(limit.limitCents)}
              {unit} <span>{limitText}</span>
            </>
          ),
          numeric: true,
        },
        ...(value === undefined ? [] : [{ label: "How sure", value: <MarketBadge value={value} now={now} /> }]),
      ]}
    />
  );
  return (
    <>
      {list}
      <MarketTrend label={label} points={market.trend.filter((p) => p.conditionGroup === group)} unit={unit} />
      {value !== undefined && (
        <details class="ia-acc app-disclosure">
          <summary class="ia-acc__trigger">
            <span class={T.label}>Details</span>
            <Icon name="chevron-down" size={16} className="ia-acc__chev" />
          </summary>
          <p class="ia-acc__content">{details(value, unit)}</p>
        </details>
      )}
    </>
  );
}

// Spec 6.6: "Of 180 listings found, 14 match your rules, 2 are under your limit."
function CheckedListings({ product, market, now }: { product: StoredProduct; market: MarketData; now: Date }) {
  const rules = { ...product.rules, matchVersion: product.matchVersion };
  const found = market.listings.length;
  // A listing without a shipping cost passes the rules but stays out of the value (spec 6.1).
  const matching = market.listings.filter((listing) => listing.outcome === "match" || listing.outcome === "unknown_shipping").length;
  const under = market.listings.filter(
    (listing) =>
      listing.outcome === "match" &&
      listing.conditionGroup !== null &&
      listing.landedCents !== null &&
      listing.landedCents <= resolveLimit(rules, listing.conditionGroup, market.ok, now).limitCents,
  ).length;
  const sentence = [
    `Of ${String(found)} ${found === 1 ? "listing" : "listings"} found,`,
    `${String(matching)} ${matching === 1 ? "matches" : "match"} your rules,`,
    `${String(under)} ${under === 1 ? "is" : "are"} under your limit.`,
  ].join(" ");
  return (
    <>
      <p>{sentence}</p>
      {/* The seller's title is text; the only link is built from the digits-only item ID. */}
      <ul>
        {market.listings.map((listing) => (
          <li>
            <a class="ia-link" href={`https://www.ebay.de/itm/${listing.legacyItemId}`} rel="noopener noreferrer" target="_blank">
              {listing.title}
            </a>{" "}
            {listing.landedCents === null ? "" : formatPrice(listing.landedCents)} {listingOutcome(listing.outcome)}
          </li>
        ))}
      </ul>
    </>
  );
}

// "Counted", or what dropped the listing: "Looks like an accessory (Accessory check)".
function listingOutcome(code: string): string {
  if (code === "match") return "Counted";
  const { label, rule } = outcomeLabel(code);
  return `${label} (${rule})`;
}

// Spec 8.4: "The eBay check did not run (daily budget reached). The last value from 21 Oct is kept."
function RefusedCheck({ refused, values }: { refused: RefusedCheckInfo; values: StoredMarketValue[] }) {
  const newest = values.reduce<Date | null>((at, value) => (at === null || value.computedAt > at ? value.computedAt : at), null);
  return (
    <Callout tone="warning">
      <p>
        {`The eBay check did not run (${refused.reason}). `}
        {newest === null ? "There is no value yet." : `The last value from ${formatDay(newest)} is kept.`}
      </p>
    </Callout>
  );
}

// The product form's aside (spec 6.5): per watched group the value and the limit, without the
// check form, which cannot sit inside the product form.
export function MarketSummary({ product, market, now }: { product: StoredProduct; market: Pick<MarketData, "values" | "ok">; now: Date }) {
  const data: MarketData = { ...market, checking: false, refused: null, listings: [], trend: [] };
  return (
    <section class="ia-surface ia-surface--md" aria-labelledby="form-market-title">
      <h2 id="form-market-title" class="type-title-sm">
        Typical asking price
      </h2>
      {watchedGroups(product).map((group) => (
        <GroupValue product={product} group={group} market={data} now={now} />
      ))}
    </section>
  );
}

export function MarketBox({
  product,
  market,
  notice,
  now,
  csrf,
}: {
  product: StoredProduct;
  market: MarketData;
  notice: string | null;
  now: Date;
  csrf: string;
}) {
  return (
    <section
      id="market"
      class="ia-surface ia-surface--md"
      aria-labelledby="market-title"
      data-market-poll={market.checking ? `/products/${product.key}/market` : undefined}
    >
      <div class="app-row">
        <h2 id="market-title" class="type-title-sm">
          Typical asking price
        </h2>
        {market.checking && <Badge tone="info">Checking</Badge>}
      </div>
      {notice !== null && (
        <Callout tone="warning">
          <p>{notice}</p>
        </Callout>
      )}
      {market.refused !== null && <RefusedCheck refused={market.refused} values={market.values} />}
      {watchedGroups(product).map((group) => (
        <GroupValue product={product} group={group} market={market} now={now} />
      ))}
      {market.listings.length > 0 && <CheckedListings product={product} market={market} now={now} />}
      <form id="market-check" method="post" action={`/products/${product.key}/market`}>
        <input type="hidden" name="_csrf" value={csrf} />
      </form>
      <div class="app-row">
        <Button type="submit" form="market-check" iconStart="refresh-cw">
          Check market value
        </Button>
        <p class="type-ui-body-sm">About 1 eBay call</p>
      </div>
    </section>
  );
}
