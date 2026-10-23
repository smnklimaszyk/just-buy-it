import { DEAL_DECISIONS, DEALS_PAGE_SIZE, dealProducts, dealsPage, type DbPool, type Deal } from "@ebay-sniper/db";
import type { Clock } from "@ebay-sniper/domain";
import { Hono } from "hono";
import type { AppEnv } from "../../session.js";
import { renderPage } from "../../shell.js";
import type { AssetManifest } from "../../ui/assets.js";
import { Button } from "../../ui/core.js";
import { Table } from "../../ui/data.js";
import { Select } from "../../ui/forms.js";
import { PageHeader, Pagination } from "../../ui/navigation.js";
import { T } from "../../ui/shared.js";
import { ClaudeCell, EbayLink, LimitCell, listingTitle, OutcomeBadge, priceText, productLabel, whenText } from "./views.js";

// What the deals page needs from the app.
export type DealsPageDeps = { pool: DbPool; clock: Clock; assets: AssetManifest };

const DECISION_LABELS: Record<(typeof DEAL_DECISIONS)[number], string> = {
  alerted: "Alerted",
  blocked: "Blocked",
  held: "Held",
  wrong_product: "Wrong product",
};

// Spec 8.3 /deals, for every signed-in person.
export function dealsRoutes(deps: DealsPageDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/", async (c) => {
    const now = deps.clock.now();
    const products = await dealProducts(deps.pool);
    // Only a key that has deals and a known decision filter; anything else shows all.
    const productKey = products.find((product) => product.key === c.req.query("product"))?.key ?? null;
    const decision = DEAL_DECISIONS.find((name) => name === c.req.query("decision")) ?? null;
    const pageParam = c.req.query("page") ?? "";
    const page = /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1;
    const { rows, total } = await dealsPage(deps.pool, { productKey, decision, page }, now);
    const pageCount = Math.max(1, Math.ceil(total / DEALS_PAGE_SIZE));
    // The filter stays on every page link.
    const filter = new URLSearchParams([
      ...(productKey === null ? [] : [["product", productKey]]),
      ...(decision === null ? [] : [["decision", decision]]),
    ]);
    filter.set("page", "");
    return c.html(
      renderPage(c, deps, {
        title: "Deals",
        active: "deals",
        children: (
          <>
            <PageHeader title="Deals" description="Alerts, and the candidates held or found to be the wrong product." />
            <form method="get" action="/deals" class="app-row">
              <Select
                id="deals-product"
                name="product"
                aria-label="Product"
                value={productKey ?? ""}
                options={[
                  { value: "", label: "All products" },
                  ...products.map((product) => ({ value: product.key, label: product.name ?? product.key })),
                ]}
              />
              <Select
                id="deals-decision"
                name="decision"
                aria-label="Outcome"
                value={decision ?? ""}
                options={[{ value: "", label: "All outcomes" }, ...DEAL_DECISIONS.map((name) => ({ value: name, label: DECISION_LABELS[name] }))]}
              />
              <Button type="submit">Filter</Button>
            </form>
            {/* Without deals a sentence, not an empty table a phone scrolls sideways. */}
            {rows.length === 0 ? (
              <p class={T.body}>No deals yet. Alerts and held or wrong-product candidates appear here.</p>
            ) : (
              <Table<Deal>
                caption="Deals, newest first"
                columns={[
                  { key: "when", label: "When", rowHeader: true, render: (deal) => whenText(deal, now) },
                  { key: "product", label: "Product", render: productLabel },
                  { key: "listing", label: "Listing", render: listingTitle },
                  { key: "price", label: "Price", numeric: true, render: priceText },
                  { key: "limit", label: "Limit", numeric: true, render: (deal) => <LimitCell deal={deal} /> },
                  { key: "outcome", label: "Outcome", render: (deal) => <OutcomeBadge deal={deal} /> },
                  { key: "claude", label: "Claude", render: (deal) => <ClaudeCell deal={deal} /> },
                  { key: "ebay", label: "eBay", render: (deal) => <EbayLink deal={deal} /> },
                ]}
                rows={rows}
              />
            )}
            {total > DEALS_PAGE_SIZE && (
              <Pagination page={page} pageCount={pageCount} total={total} pageSize={DEALS_PAGE_SIZE} href={`/deals?${filter.toString()}`} />
            )}
          </>
        ),
      }),
    );
  });

  return routes;
}
