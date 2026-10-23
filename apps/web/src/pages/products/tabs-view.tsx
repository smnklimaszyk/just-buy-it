import { parseProductRules } from "@ebay-sniper/domain";
import { Table } from "../../ui/data.js";
import { Badge, type Tone } from "../../ui/feedback.js";
import { Tabs } from "../../ui/navigation.js";
import { formatPrice, formatStamp, formatWhen, outcomeLabel } from "./format.js";
import { formValuesFromRules, type FieldName, type ProductFormValues } from "./form.js";
import { fieldLabel } from "./form-view.js";
import { STATUS } from "./list-view.js";
import { DEAL_FILTERS, type DealFilter, type FilteredCount, type FilteredTitle, type ProductDeal, type ProductRevision } from "./queries.js";

// Spec 8.3: the Deals, Filtered out and History tabs of /products/:key.

const DECISION: Record<string, { label: string; tone: Tone }> = {
  alerted: { label: "Alerted", tone: "success" },
  held: { label: "Held", tone: "warning" },
  wrong_product: { label: "Wrong product", tone: "neutral" },
};

// "claude_unavailable" as "Claude unavailable".
const words = (code: string): string => {
  const text = code.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// Per reason the listings dropped in the last 24 hours and 7 days, most first (spec 8.3).
export function FilteredTab({ counts }: { counts: FilteredCount[] }) {
  return (
    <Table<FilteredCount>
      caption="Filtered out by reason"
      columns={[
        { key: "reason", label: "Reason", rowHeader: true, render: (count) => outcomeLabel(count.outcome).label },
        { key: "rule", label: "Rule", render: (count) => outcomeLabel(count.outcome).rule },
        { key: "day", label: "Last 24 h", numeric: true, render: (count) => String(count.day) },
        { key: "week", label: "Last 7 days", numeric: true, render: (count) => String(count.week) },
      ]}
      rows={counts}
    />
  );
}

// The titles of the last 6 hours with the rule that fired; no item ID is kept, so no links.
export function FilteredTitles({ titles, now }: { titles: FilteredTitle[]; now: Date }) {
  return (
    <Table<FilteredTitle>
      caption="Titles of the last 6 hours"
      columns={[
        { key: "title", label: "Title", rowHeader: true, render: (row) => row.title },
        { key: "price", label: "Price", numeric: true, render: (row) => price(row.landedCents) },
        {
          key: "reason",
          label: "Filtered by",
          render: (row) => {
            const { label, rule } = outcomeLabel(row.reason ?? "unknown");
            return `${label} (${rule})`;
          },
        },
        { key: "when", label: "When", render: (row) => formatWhen(row.seenAt, now) },
      ]}
      rows={titles}
    />
  );
}

// "Command line" for ops, the person's email for a user actor, else the actor as stored.
const actorName = (revision: ProductRevision): string => revision.email ?? (revision.actor === "system:cli" ? "Command line" : revision.actor);

const shown = (value: ProductFormValues[FieldName]): string => (Array.isArray(value) ? value.join(", ") : String(value)) || "empty";

// The form fields a revision changed against the one before, in the form's words.
function changes(before: unknown, after: unknown): string[] {
  const old = parseProductRules(before);
  const next = parseProductRules(after);
  if (!old.ok || !next.ok) return ["Rules changed"];
  const was = formValuesFromRules(old.value);
  const now = formValuesFromRules(next.value);
  const status = old.value.status === next.value.status ? [] : [`Status: was ${STATUS[old.value.status].label}, now ${STATUS[next.value.status].label}`];
  return [
    ...status,
    ...(Object.keys(now) as FieldName[])
      .filter((name) => shown(was[name]) !== shown(now[name]))
      .map((name) => `${fieldLabel(name, now)}: was ${shown(was[name])}, now ${shown(now[name])}`),
  ];
}

// Spec 8.3: the revisions with what changed, who and when, newest first.
export function HistoryTab({ revisions }: { revisions: ProductRevision[] }) {
  return (
    <Table<ProductRevision>
      caption="Revisions"
      columns={[
        { key: "version", label: "Version", numeric: true, rowHeader: true, render: (revision) => String(revision.version) },
        { key: "who", label: "Who", render: actorName },
        { key: "when", label: "When", render: (revision) => formatStamp(revision.createdAt) },
        {
          key: "what",
          label: "What changed",
          render: (revision) => {
            const previous = revisions.find((r) => r.version === revision.version - 1);
            if (previous === undefined) return "Created";
            return changes(previous.rules, revision.rules).map((line) => <div>{line}</div>);
          },
        },
      ]}
      rows={revisions}
    />
  );
}

const price = (cents: number | null): string => (cents === null ? "" : formatPrice(cents));

// Spec 8.3: the alerted, held and wrong-product candidates with Claude's reason, filtered by
// decision. The seller's title is text; the only link is built from the digits-only item ID.
export function DealsTab({ deals, show, productKey, now }: { deals: ProductDeal[]; show: DealFilter | null; productKey: string; now: Date }) {
  const href = (filter: DealFilter | null) => `/products/${productKey}/deals${filter === null ? "" : `?show=${filter}`}`;
  return (
    <>
      <Tabs
        label="Filter deals"
        value={show ?? ""}
        tabs={[
          { value: "", label: "All", href: href(null) },
          ...DEAL_FILTERS.map((filter) => ({ value: filter, label: DECISION[filter]?.label ?? filter, href: href(filter) })),
        ]}
      />
      <Table<ProductDeal>
        caption="Deals"
        columns={[
          {
            key: "title",
            label: "Listing",
            rowHeader: true,
            render: (deal) => {
              const title = deal.title ?? "Title deleted after 6 hours";
              if (deal.legacyItemId === null) return title;
              return (
                <a class="ia-link" href={`https://www.ebay.de/itm/${deal.legacyItemId}`} rel="noopener noreferrer" target="_blank">
                  {title}
                </a>
              );
            },
          },
          { key: "price", label: "Price", numeric: true, render: (deal) => price(deal.landedCents) },
          { key: "limit", label: "Limit", numeric: true, render: (deal) => price(deal.limitCents) },
          {
            key: "decision",
            label: "Outcome",
            render: (deal) => {
              const decision = DECISION[deal.decision] ?? { label: words(deal.decision), tone: "neutral" };
              return <Badge tone={decision.tone}>{decision.label}</Badge>;
            },
          },
          { key: "reason", label: "Reason", render: (deal) => deal.claudeReason ?? (deal.heldReason === null ? "" : words(deal.heldReason)) },
          { key: "when", label: "When", render: (deal) => formatWhen(deal.createdAt, now) },
        ]}
        rows={deals}
      />
    </>
  );
}
