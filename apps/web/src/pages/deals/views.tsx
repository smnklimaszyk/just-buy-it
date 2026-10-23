import type { Deal } from "@ebay-sniper/db";
import type { Verdict } from "@ebay-sniper/domain";
import { Link } from "../../ui/core.js";
import { Badge, type Tone } from "../../ui/feedback.js";
import { T } from "../../ui/shared.js";
import { formatPrice, formatWhen } from "../products/format.js";

// Spec 8.3: how the overview and the deals page show one deal. The seller's title is text; the
// only link is built from the digits-only item ID.

// The product's name, or the key for a key no product has.
export const productLabel = (deal: Deal): string => deal.productName ?? deal.productKey;

export const listingTitle = (deal: Deal): string => deal.title ?? "Title deleted after 6 hours";

// The landed price, or the item price while shipping is unknown. Empty once the purge emptied it.
export function priceText(deal: Deal): string {
  if (deal.landedCents !== null) return formatPrice(deal.landedCents);
  return deal.priceCents === null ? "" : `${formatPrice(deal.priceCents)} + shipping`;
}

const perUnit = (deal: Deal): string => (deal.limit?.perGb === true ? " per GB" : "");

// "claude_unavailable" as "Claude unavailable".
const words = (code: string): string => {
  const text = code.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// The limit the candidate passed, and "using your cap" when market mode had no usable value.
export function LimitCell({ deal }: { deal: Deal }) {
  if (deal.limit === null) return <></>;
  return (
    <>
      <span>{`${formatPrice(deal.limit.cents)}${perUnit(deal)}${deal.usingCap ? ", using your cap" : ""}`}</span>{" "}
      {deal.percentOfLimit !== null && <span class={T.caption}>{`${String(deal.percentOfLimit)} % of limit`}</span>}
    </>
  );
}

// The market line (spec 6.5): the typical asking price the limit came from, in the email's words.
export function marketText(deal: Deal): string {
  if (deal.priceMode !== "below_market") return "Fixed max price";
  if (deal.marketValue === null) return "No reliable market value";
  const value = `${formatPrice(deal.marketValue.cents)}${perUnit(deal)}`;
  if (deal.marketValue.percentBelow === null) return `Typical asking price ${value}`;
  return `${String(deal.marketValue.percentBelow)} % below the typical asking price of ${value}`;
}

type Shown = { label: string; tone: Tone };

const VERDICT: Record<Verdict, Shown> = {
  pass: { label: "Passed", tone: "success" },
  caution: { label: "Caution", tone: "warning" },
  block: { label: "Blocked", tone: "danger" },
};

const NOT_CHECKED: Shown = { label: "Not checked by Claude", tone: "neutral" };

// What Claude said: the alert's verdict, "Not checked by Claude" when Claude could not check
// (owner decision 6), or that the listing is not the product. Below it Claude's reason while its
// text is kept, or why a candidate was held.
function claudeShown(deal: Deal): Shown | null {
  if (deal.verdict !== null) return deal.verdict.screened ? VERDICT[deal.verdict.finalVerdict] : NOT_CHECKED;
  if (deal.decision === "held") return NOT_CHECKED;
  if (deal.productMatch === "mismatch") return { label: "Not this product", tone: "neutral" };
  return null;
}

export function ClaudeCell({ deal }: { deal: Deal }) {
  const shown = claudeShown(deal);
  const note = deal.claudeReason ?? (deal.heldReason === null ? null : words(deal.heldReason));
  return (
    <>
      {shown !== null && <Badge tone={shown.tone}>{shown.label}</Badge>}
      {note !== null && <p class={T.caption}>{note}</p>}
    </>
  );
}

const OUTCOME: Record<string, Shown> = {
  alerted: { label: "Alerted", tone: "success" },
  blocked: { label: "Blocked", tone: "danger" },
  held: { label: "Held", tone: "warning" },
  wrong_product: { label: "Wrong product", tone: "neutral" },
};

// Spec 8.2: a deal's decision as a Badge.
export function OutcomeBadge({ deal }: { deal: Deal }) {
  const outcome = OUTCOME[deal.decision] ?? { label: words(deal.decision), tone: "neutral" };
  return <Badge tone={outcome.tone}>{outcome.label}</Badge>;
}

export const whenText = (deal: Deal, now: Date): string => formatWhen(deal.alertedAt ?? deal.createdAt, now);

export function EbayLink({ deal }: { deal: Deal }) {
  if (deal.legacyItemId === null) return <></>;
  return (
    <Link href={`https://www.ebay.de/itm/${deal.legacyItemId}`} external>
      Open on eBay
    </Link>
  );
}
