import {
  collapseWhitespace,
  finalVerdict,
  formatAsOf,
  formatEur,
  removeHiddenCharacters,
  routeAlert,
  vatLine,
  type AlertLabel,
  type BuyerProfile,
  type CodeSignal,
  type PriceMode,
  type ProductMatch,
  type SellerAccountType,
  type Verdict,
} from "@ebay-sniper/domain";

// The Claude result of the alert's listing, or the failure or skip code when there is none.
export type AlertScreening =
  | { screened: true; verdict: Verdict; productMatch: ProductMatch; riskFlags: readonly string[]; reason: string }
  | { screened: false; code: string };

// The product the alert is for, as the buyer named it.
export type AlertProduct = { name: string; perGb: boolean };

// The limit the listing passed (spec 6.4), per GB when the product prices per GB. In market mode
// `marketValueCents` is the typical asking price the limit came from, or null when the cap applies
// ("using your cap"). The email, the product page and Claude get the same number.
export type AlertLimit = { limitCents: number; priceMode: PriceMode; marketValueCents: number | null };

// Everything one alert email shows. There is no field for the seller's identity, so it cannot
// reach the email.
export type AlertEmailInput = {
  deliveryId: string;
  product: AlertProduct;
  limit: AlertLimit;
  buyerProfile: BuyerProfile;
  legacyItemId: string;
  title: string;
  // When the listing content was fetched.
  asOf: Date;
  priceCents: number;
  // null while shipping to DE is unknown; never counted as zero.
  shippingCents: number | null;
  // Products priced per GB only.
  totalGb: number | null;
  condition: string | null;
  seller: { accountType: SellerAccountType | null; feedbackScore: number | null; feedbackPercent: number | null };
  // null for an alert built from summary data (getItem did not run).
  returns: { accepted: boolean | null; periodDays: number | null } | null;
  // The candidate's flags as the matcher wrote them, `warn:<word>` included.
  flags: readonly string[];
  // The cleaned description, read only for the VAT line.
  descriptionText: string | null;
  screening: AlertScreening;
  codeSignals: readonly CodeSignal[];
};

export type AlertEmail = { subject: string; text: string; html: string };

// One labelled entry; the first value sits on the label's line, the others below it.
type Row = { label: string; values: string[] };

// The body once, before it becomes text or HTML.
type Content = {
  title: string;
  asOf: string;
  details: Row[];
  // Anything but PASS: the screening part is boxed in the HTML part.
  warning: boolean;
  screeningHeading: string;
  screeningRows: Row[];
  screeningNotes: string[];
  vat: string;
  link: string;
  checklist: string[];
  footer: string;
};

const FLAG_WORDS: Record<string, string> = {
  untested: "untested",
  mining_history: "mining history",
  custom_cooling: "custom cooling",
  pickup_only: "pickup only",
  shipping_unknown: "shipping unknown",
  financing: "financing offered",
  open_box_or_refurbished: "open box or refurbished",
  low_feedback: "fewer than 10 ratings",
  best_offer: "best offer possible",
};

const WARN_PREFIX = "warn:";

const CHECKLIST = [
  "Buy only through eBay checkout. Never pay or talk outside eBay.",
  "Check that the listing is still available and the photos match the title.",
  "Company purchase: use the Intra AI business account.",
];

type EmailedLabel = Exclude<AlertLabel, "blocked_by_code">;

const SUBJECT_MARK: Record<EmailedLabel, string> = {
  pass: "PASS",
  check: "CHECK",
  claude_says_block: "CLAUDE SAYS BLOCK",
  not_screened: "NOT CHECKED BY CLAUDE",
};
const SCREENING_HEADING: Record<EmailedLabel, string> = {
  pass: "PASS",
  check: "CHECK BEFORE BUYING",
  claude_says_block: "CLAUDE SAYS BLOCK",
  not_screened: "NOT CHECKED",
};

// Section 6.2: the model's reason, cut for the email.
const MAX_REASON_CHARS = 300;

// Seller, buyer and model text on one line: hidden characters removed, line breaks and runs of
// whitespace collapsed, so it cannot shift the layout or forge a line of the email.
const oneLine = (text: string): string => collapseWhitespace(removeHiddenCharacters(text));
// Cut to a number of code points, so no surrogate pair is split.
const cut = (text: string, maxChars: number): string => [...text].slice(0, maxChars).join("");

const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));
// "no_returns" -> "no returns"
const words = (code: string): string => code.replaceAll("_", " ");
const wholeEur = (cents: number): string => `EUR ${Math.round(cents / 100).toLocaleString("en-US")}`;
const row = (label: string, ...values: string[]): Row => ({ label, values });

function flagText(flag: string): string {
  if (flag.startsWith(WARN_PREFIX)) return `contains "${oneLine(flag.slice(WARN_PREFIX.length))}"`;
  return FLAG_WORDS[flag] ?? words(flag);
}

function sellerText(seller: AlertEmailInput["seller"]): string {
  const parts = [seller.accountType ?? "type unknown"];
  if (seller.feedbackScore !== null) parts.push(`${seller.feedbackScore.toLocaleString("en-US")} ratings`);
  if (seller.feedbackPercent !== null) parts.push(`${seller.feedbackPercent}% positive`);
  return parts.join(", ");
}

// ---- plain text ------------------------------------------------------------------------------

const LABEL_WIDTH = 15;

function textRow({ label, values }: Row): string[] {
  const [first = "", ...rest] = values;
  return [`${`${label}:`.padEnd(LABEL_WIDTH)}${first}`, ...rest.map((value) => `${" ".repeat(LABEL_WIDTH)}${value}`)];
}

function toText(content: Content): string {
  return [
    content.title,
    content.asOf,
    "",
    ...content.details.flatMap(textRow),
    "",
    content.screeningHeading,
    ...content.screeningRows.flatMap(textRow),
    ...content.screeningNotes,
    "",
    ...textRow(row("VAT", content.vat)),
    "",
    ...textRow(row("Open on eBay", content.link)),
    "",
    ...content.checklist,
    "",
    content.footer,
    "",
  ].join("\n");
}

// ---- HTML ------------------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

const htmlRow = ({ label, values }: Row): string =>
  `<tr><th>${escapeHtml(label)}</th><td>${values.map(escapeHtml).join("<br>")}</td></tr>`;
const htmlTable = (rows: Row[]): string => `<table>${rows.map(htmlRow).join("")}</table>`;

function toHtml(content: Content): string {
  const link = escapeHtml(content.link);
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    "<style>th{text-align:left;vertical-align:top;padding-right:12px;font-weight:normal;color:#555}</style>",
    "</head><body>",
    `<p><strong>${escapeHtml(content.title)}</strong><br>${escapeHtml(content.asOf)}</p>`,
    htmlTable(content.details),
    content.warning ? '<div class="warning" style="border:2px solid #c60;padding:4px 12px;margin:12px 0">' : "<div>",
    `<p><strong>${escapeHtml(content.screeningHeading)}</strong></p>`,
    htmlTable(content.screeningRows),
    ...content.screeningNotes.map((note) => `<p>${escapeHtml(note)}</p>`),
    "</div>",
    `<table><tr><th>VAT</th><td>${escapeHtml(content.vat)}</td></tr>`,
    `<tr><th>Open on eBay</th><td><a href="${link}">${link}</a></td></tr></table>`,
    `<p>${content.checklist.map(escapeHtml).join("<br>")}</p>`,
    `<p>${escapeHtml(content.footer)}</p>`,
    "</body></html>",
    "",
  ].join("\n");
}

// ---- content ---------------------------------------------------------------------------------

type ScreeningPart = Pick<Content, "screeningHeading" | "screeningRows" | "screeningNotes">;

function screeningPart(
  screening: AlertScreening,
  label: EmailedLabel,
  productMatch: ProductMatch | null,
  codeSignals: readonly CodeSignal[],
): ScreeningPart {
  // The code signals that raised the verdict to at least caution (section 5.6).
  const codeRows = codeSignals.length === 0 ? [] : [row("Code checks", list(codeSignals.map(words)))];
  if (!screening.screened) {
    return {
      screeningHeading: `Claude check: ${SCREENING_HEADING.not_screened}`,
      screeningRows: codeRows,
      // Owner decision 6: an alert Claude could not check says so, with the reason.
      screeningNotes: [`Not checked by Claude: ${oneLine(screening.code)}. Check the listing yourself.`],
    };
  }
  const notes: string[] = [];
  // Spec 4.3: unclear, or a listing that tried to address the model.
  if (productMatch === "unclear") notes.push("Claude is not sure this is the product.");
  if (label === "claude_says_block") {
    notes.push("Code checks found no payment or contact scam sign. Read the listing carefully before buying.");
  }
  return {
    screeningHeading: `Claude check: ${SCREENING_HEADING[label]}`,
    screeningRows: [
      row("Reason", cut(oneLine(screening.reason), MAX_REASON_CHARS)),
      row("Risk flags", list(screening.riskFlags.map(words))),
      ...codeRows,
    ],
    screeningNotes: notes,
  };
}

function returnsText(returns: AlertEmailInput["returns"]): string {
  if (returns === null) return "not fetched";
  if (returns.accepted === null) return "unknown";
  if (!returns.accepted) return "none";
  return returns.periodDays === null ? "accepted" : `accepted, ${returns.periodDays} days`;
}

type PriceAgainstLimit = { subjectName: string; subjectNote: string; limitRow: Row };

const percentOf = (part: number, whole: number): number => Math.round((part / whole) * 100);

// How the price stands against the limit: in market mode with a value, how far below the typical
// asking price it is; otherwise its share of the limit, and "using your cap" when market mode
// had no value. Per GB the price per GB is compared, rounded to the cent only for display.
function priceAgainstLimit(input: AlertEmailInput, basisCents: number): PriceAgainstLimit {
  const { product, limit } = input;
  const name = oneLine(product.name);
  const usingCap = limit.priceMode === "below_market" && limit.marketValueCents === null;
  const units = product.perGb ? input.totalGb : 1;
  // The matcher rejects a per-GB listing without a total before any alert.
  if (units === null) throw new Error("a product priced per GB needs the total GB");
  const unit = product.perGb ? " per GB" : "";
  const limitText = `${formatEur(limit.limitCents)}${unit}${usingCap ? ", using your cap" : ""}`;
  let standing: string;
  let subjectStanding: string;
  if (limit.marketValueCents === null) {
    const percent = percentOf(basisCents, limit.limitCents * units);
    standing = `${percent} % of your limit`;
    subjectStanding = usingCap ? "using your cap" : `${percent} % of limit`;
  } else {
    const below = 100 - percentOf(basisCents, limit.marketValueCents * units);
    const value = `${formatEur(limit.marketValueCents)}${unit}`;
    standing = `${below} % below the typical asking price of ${value}`;
    subjectStanding = `${below} % below the typical asking price`;
  }
  if (!product.perGb) {
    return { subjectName: name, subjectNote: subjectStanding, limitRow: row("Limit", limitText, standing) };
  }
  const perGb = `${formatEur(Math.round(basisCents / units))} per GB`;
  return {
    subjectName: `${name} ${units} GB`,
    subjectNote: `${perGb}, ${subjectStanding}`,
    limitRow: row("Limit", limitText, `${units} GB at ${perGb}, ${standing}`),
  };
}

export function renderAlertEmail(input: AlertEmailInput): AlertEmail {
  const shippingCents = input.shippingCents;
  // With shipping unknown the item price alone is compared, as in the price rules; it is the
  // lowest the landed price can be, never a landed price with zero shipping.
  const basisCents = shippingCents === null ? input.priceCents : input.priceCents + shippingCents;
  const price = priceAgainstLimit(input, basisCents);
  const priceShown =
    shippingCents === null ? `${wholeEur(basisCents)} + unknown shipping` : `${wholeEur(basisCents)} incl. shipping`;
  const shippingRows =
    shippingCents === null
      ? [row("Shipping", `unknown, landed price at least ${formatEur(basisCents)}`)]
      : [row("Shipping", formatEur(shippingCents)), row("Landed price", formatEur(basisCents))];
  const screening = input.screening;
  const verdict = finalVerdict(
    screening.screened
      ? { screened: true, verdict: screening.verdict, productMatch: screening.productMatch, riskFlags: screening.riskFlags }
      : { screened: false, code: screening.code },
    input.codeSignals,
  );
  const route = routeAlert(verdict);
  // Section 5.7: a code-verified scam floor keeps the alert on the dashboard only.
  if (route.label === "blocked_by_code") throw new Error("an alert blocked by a code scam floor is never emailed");
  const subject = `[Deal] ${price.subjectName}: ${priceShown} (${price.subjectNote}) - ${SUBJECT_MARK[route.label]}`;
  const content: Content = {
    title: oneLine(input.title),
    asOf: formatAsOf(input.asOf),
    details: [
      row("Product", oneLine(input.product.name)),
      row("Price", formatEur(input.priceCents)),
      ...shippingRows,
      price.limitRow,
      row("Condition", input.condition === null ? "unknown" : oneLine(input.condition)),
      row("Seller", sellerText(input.seller)),
      row("Returns", returnsText(input.returns)),
      row("Flags", list(input.flags.map(flagText))),
    ],
    warning: route.label !== "pass",
    ...screeningPart(screening, route.label, verdict.productMatch, input.codeSignals),
    vat: vatLine({
      profile: input.buyerProfile,
      sellerAccountType: input.seller.accountType,
      title: input.title,
      description: input.descriptionText ?? "",
      grossCents: basisCents,
    }),
    link: `https://www.ebay.de/itm/${encodeURIComponent(input.legacyItemId)}`,
    checklist: CHECKLIST,
    footer: `Delivery ${input.deliveryId} - just-buy-it`,
  };
  return { subject, text: toText(content), html: toHtml(content) };
}
