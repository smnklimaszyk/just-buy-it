import type { StoredProduct } from "@ebay-sniper/db";
import {
  CONDITION_GROUPS,
  conditionGroupOf,
  isOutOfDate,
  resolveLimit,
  type ConditionGroup,
  type MarketValueRef,
  type ProductStatus,
} from "@ebay-sniper/domain";
import { ButtonLink, Link } from "../../ui/core.js";
import { Table } from "../../ui/data.js";
import { Badge, EmptyState, type Tone } from "../../ui/feedback.js";
import { Menu, PageHeader, Tabs, type MenuItem } from "../../ui/navigation.js";
import { ConfirmDialog } from "../../ui/overlays.js";
import { formatPrice, formatWhen } from "./format.js";
import type { CurrentValues, ProductActivity } from "./queries.js";

export const STATUS: Record<ProductStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "neutral" },
  draft: { label: "Draft", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
};

// Spec 8.2: Active success, Paused neutral, Draft info, Archived neutral.
export const StatusBadge =({ status }: { status: ProductStatus }) => <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;

const unitOf = (product: StoredProduct): string => (product.rules.perGb ? " per GB" : "");

// "Fixed max EUR 450" or "15 % below the typical asking price, never above EUR 550".
export function priceRule(product: StoredProduct): string {
  const { rules } = product;
  if (rules.priceMode === "fixed") return `Fixed max ${formatPrice(rules.maxCents)}${unitOf(product)}`;
  return `${String(rules.belowMarketPct)} % below the typical asking price, never above ${formatPrice(rules.maxCents)}${unitOf(product)}`;
}

export const GROUP_LABEL: Record<ConditionGroup, string> = { new: "New", open_box: "Open box", refurbished: "Refurbished", used: "Used" };

// The condition groups a product watches, in the form's order.
export const watchedGroups = (product: StoredProduct): ConditionGroup[] =>
  CONDITION_GROUPS.filter((group) => product.rules.conditionIds.some((id) => conditionGroupOf(id) === group));

// Spec 6.4 and owner decision 7: the limit a listing first seen now would get, per watched group.
function limitLines(product: StoredProduct, values: CurrentValues | undefined, now: Date): string[] {
  return watchedGroups(product).map((group) => {
    const limit = resolveLimit({ ...product.rules, matchVersion: product.matchVersion }, group, values?.ok ?? [], now);
    return `${GROUP_LABEL[group]}: ${formatPrice(limit.limitCents)}${unitOf(product)}${limit.usingCap ? ", using your cap" : ""}`;
  });
}

// Spec 6.5: Reliable, Rough, Not enough listings, and Out of date when read more than 48 h later.
export function MarketBadge({ value, now }: { value: MarketValueRef; now: Date }) {
  if (isOutOfDate(value.computedAt, now)) return <Badge tone="warning">Out of date</Badge>;
  if (value.status === "ok") return <Badge tone="success">Reliable</Badge>;
  if (value.status === "rough") return <Badge tone="warning">Rough</Badge>;
  return <Badge>Not enough listings</Badge>;
}

// The row actions: Edit, Pause or Resume, and Archive behind a ConfirmDialog (spec 8.2).
function rowMenu(product: StoredProduct): MenuItem[] {
  const { status } = product.rules;
  const items: MenuItem[] = [{ label: "Edit", icon: "pencil", href: `/products/${product.key}/edit` }];
  if (status === "active") items.push({ label: "Pause", icon: "pause", form: `status-${product.key}`, name: "status", value: "paused" });
  if (status === "paused") items.push({ label: "Resume", icon: "play", form: `status-${product.key}`, name: "status", value: "active" });
  if (status !== "archived") items.push({ label: "Archive", icon: "archive", danger: true, commandfor: `archive-${product.key}`, command: "show-modal" });
  return items;
}

// What every status change posts besides the status: the version it was made on (spec 5.3) and
// the page to go back to.
export const StatusFields = ({ product, csrf, back }: { product: StoredProduct; csrf: string; back: string }) => (
  <>
    <input type="hidden" name="_csrf" value={csrf} />
    <input type="hidden" name="version" value={String(product.version)} />
    <input type="hidden" name="back" value={back} />
  </>
);

export function ArchiveDialog({ product, csrf, back }: { product: StoredProduct; csrf: string; back: string }) {
  return (
    <ConfirmDialog
      id={`archive-${product.key}`}
      title="Archive this product?"
      description="It is no longer polled or checked. Its history stays, and you can still open and edit it."
      confirmLabel="Archive product"
      action={`/products/${product.key}/status`}
      fields={
        <>
          <StatusFields product={product} csrf={csrf} back={back} />
          <input type="hidden" name="status" value="archived" />
        </>
      }
    />
  );
}

export const STATUS_FILTERS: { value: "" | ProductStatus; label: string }[] = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "paused", label: "Paused" },
  { value: "archived", label: "Archived" },
];

const filterHref = (value: string): string => (value === "" ? "/products" : `/products?status=${value}`);

export type ProductListProps = {
  // The products of the chosen filter; `anyProduct` tells an empty filter from no products at all.
  products: StoredProduct[];
  anyProduct: boolean;
  filter: string;
  values: Map<string, CurrentValues>;
  activity: Map<string, ProductActivity>;
  now: Date;
  csrf: string;
};

// Spec 8.3 /products. On the empty list the page header has no button and the empty state
// carries the one primary "Add product" (spec 8.2).
export function ProductList({ products, anyProduct, filter, values, activity, now, csrf }: ProductListProps) {
  if (!anyProduct) {
    return (
      <>
        <PageHeader title="Products" />
        <EmptyState
          icon="layers"
          title="No products yet"
          description="Add the first product you want to watch. It starts as a draft, so nothing is polled until you activate it."
          action={
            <ButtonLink href="/products/new" variant="primary" iconStart="plus">
              Add product
            </ButtonLink>
          }
        />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Products"
        actions={
          <ButtonLink href="/products/new" variant="primary" iconStart="plus">
            Add product
          </ButtonLink>
        }
        tabs={
          <Tabs
            label="Filter by status"
            value={filter}
            tabs={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label, href: filterHref(f.value) }))}
          />
        }
      />
      <Table<StoredProduct>
        caption="Products"
        columns={[
          { key: "name", label: "Name", rowHeader: true, render: (product) => <Link href={`/products/${product.key}`}>{product.rules.name}</Link> },
          { key: "status", label: "Status", render: (product) => <StatusBadge status={product.rules.status} /> },
          { key: "price", label: "Price rule", render: priceRule },
          { key: "limit", label: "Current limit", render: (product) => limitLines(product, values.get(product.id), now).map((line) => <div>{line}</div>) },
          {
            key: "market",
            label: "Typical asking price",
            render: (product) => {
              const newest = (values.get(product.id)?.newest ?? []).filter((value) => value.valueCents !== null);
              if (newest.length === 0) return "No value yet";
              return newest.map((value) => (
                <div>
                  {GROUP_LABEL[value.conditionGroup]}: {formatPrice(value.valueCents ?? 0)}
                  {unitOf(product)} <MarketBadge value={value} now={now} />
                </div>
              ));
            },
          },
          {
            key: "candidates",
            label: "Candidates today",
            numeric: true,
            render: (product) => `${String(activity.get(product.key)?.candidatesToday ?? 0)} / ${String(product.rules.candidateCapPerDay)}`,
          },
          {
            key: "deal",
            label: "Last deal",
            render: (product) => {
              const at = activity.get(product.key)?.lastDealAt ?? null;
              return at === null ? "None yet" : formatWhen(at, now);
            },
          },
          {
            key: "actions",
            label: <span class="ia-sr">Actions</span>,
            render: (product) => (
              <>
                <form id={`status-${product.key}`} method="post" action={`/products/${product.key}/status`}>
                  <StatusFields product={product} csrf={csrf} back="/products" />
                </form>
                <Menu items={rowMenu(product)} label={`Actions for ${product.rules.name}`} align="end" />
              </>
            ),
          },
        ]}
        rows={products}
      />
      {products
        .filter((product) => product.rules.status !== "archived")
        .map((product) => (
          <ArchiveDialog product={product} csrf={csrf} back="/products" />
        ))}
    </>
  );
}
