import type { StoredProduct } from "@ebay-sniper/db";
import { PLANNED_CALLS_CEILING } from "@ebay-sniper/domain";
import type { ClientScript } from "../../ui/assets.js";
import { Button, ButtonLink } from "../../ui/core.js";
import { DescriptionList } from "../../ui/data.js";
import { PageHeader, Tabs } from "../../ui/navigation.js";
import type { Child } from "../../ui/shared.js";
import { GROUP_LABEL, priceRule, StatusBadge, StatusFields, watchedGroups } from "./list-view.js";

// Spec 8.3 /products/:key: the page header with the status Badge and one primary, and the tabs.

// The menus and the confirm dialog of the header, and the market box's poll while a check runs.
export const PAGE_SCRIPTS: ClientScript[] = ["menu", "dialog", "market-poll", "form-busy"];

export type ProductTab = "overview" | "deals" | "filtered" | "history";

const TABS: { value: ProductTab; label: string; path: string }[] = [
  { value: "overview", label: "Overview", path: "" },
  { value: "deals", label: "Deals", path: "/deals" },
  { value: "filtered", label: "Filtered out", path: "/filtered" },
  { value: "history", label: "History", path: "/history" },
];

// "Activate product" on a draft, "Edit product" otherwise (spec 8.3).
function HeaderActions({ product, csrf }: { product: StoredProduct; csrf: string }) {
  const edit = `/products/${product.key}/edit`;
  if (product.rules.status !== "draft") {
    return (
      <ButtonLink href={edit} variant="primary" iconStart="pencil">
        Edit product
      </ButtonLink>
    );
  }
  return (
    <div class="app-row">
      <form method="post" action={`/products/${product.key}/status`}>
        <StatusFields product={product} csrf={csrf} back={`/products/${product.key}`} />
        <Button type="submit" variant="primary" name="status" value="active" iconStart="play">
          Activate product
        </Button>
      </form>
      <ButtonLink href={edit} iconStart="pencil">
        Edit product
      </ButtonLink>
    </div>
  );
}

export function ProductPage({ product, tab, csrf, children }: { product: StoredProduct; tab: ProductTab; csrf: string; children?: Child }) {
  return (
    <>
      <PageHeader
        title={product.rules.name}
        description={<StatusBadge status={product.rules.status} />}
        actions={<HeaderActions product={product} csrf={csrf} />}
        tabs={<Tabs label="Product" value={tab} tabs={TABS.map((t) => ({ value: t.value, label: t.label, href: `/products/${product.key}${t.path}` }))} />}
      />
      {children}
    </>
  );
}

const listOrNone = (items: readonly string[]): string => (items.length === 0 ? "None" : items.join(", "));

// What the product adds to the planned eBay calls of a day, and the plan's total with it.
export type ProductCost = { draft: boolean; calls: number; total: number };

// The Overview tab: the rules as one DescriptionList (spec 8.2) and the cost line.
export function OverviewTab({ product, cost }: { product: StoredProduct; cost: ProductCost }) {
  const { rules } = product;
  const plan = `${cost.total.toLocaleString("en-US")} of ${PLANNED_CALLS_CEILING.toLocaleString("en-US")} planned.`;
  return (
    <>
      <p class="type-ui-body-sm">
        {cost.draft
          ? `Once active, this product adds about ${String(cost.calls)} eBay calls a day: ${plan}`
          : `This product takes about ${String(cost.calls)} eBay calls a day: ${plan}`}
      </p>
      <DescriptionList
        items={[
          { label: "Search words", value: rules.searchWords.join(", ") },
          { label: "Must contain", value: rules.mustWords.map((group) => <div>{group.join(", ")}</div>) },
          { label: "Must not contain", value: listOrNone(rules.excludeWords) },
          { label: "eBay category", value: rules.categoryName === null ? rules.categoryId : `${rules.categoryId} ${rules.categoryName}` },
          { label: "Condition", value: watchedGroups(product).map((group) => GROUP_LABEL[group]).join(", ") },
          { label: "Price rule", value: priceRule(product) },
        ]}
      />
    </>
  );
}
