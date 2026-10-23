import { loadSettings, type DbPool } from "@ebay-sniper/db";
import { SPEED_INTERVALS, type Clock, type DailyCallPlan, type SettingsEnv } from "@ebay-sniper/domain";
import { Hono } from "hono";
import type { AppEnv } from "../../session.js";
import { renderPage } from "../../shell.js";
import type { AssetManifest } from "../../ui/assets.js";
import { Table } from "../../ui/data.js";
import { Meter } from "../../ui/feedback.js";
import { PageHeader } from "../../ui/navigation.js";
import { T } from "../../ui/shared.js";
import { formatWhen } from "../products/format.js";
import { claudeCallsToday, liveSearches, quotaUsed, storedCallPlan, type ProductCalls, type SearchListing } from "./queries.js";

// What the budget page needs from the app.
export type BudgetPageDeps = {
  pool: DbPool;
  clock: Clock;
  assets: AssetManifest;
  // The Claude call ceiling sets the item-details line (spec 5.2).
  settingsEnv: SettingsEnv;
};

const count = (n: number): string => n.toLocaleString("en-US");

// reserve_ebay_call refuses every call at 80 % of eBay's 5,000 a day (spec 1.3).
const QUOTA_HARD_CAP = 4_000;

type PlanLine = { label: string; calls: number };

const planLines = (plan: DailyCallPlan): PlanLine[] => [
  { label: "Polls", calls: plan.polls },
  { label: "Overflow pages", calls: plan.overflow },
  { label: "Price-drop sweeps", calls: plan.sweeps },
  { label: "Item details for the Claude check", calls: plan.getItem },
  { label: "Market value", calls: plan.market },
  { label: "Total", calls: plan.total },
];

// The speed preset of a search's intervals (ADR 0037), or the intervals themselves.
function speedOf(search: SearchListing): string {
  const preset = Object.entries(SPEED_INTERVALS).find(
    ([, intervals]) => intervals.dayIntervalS === search.dayIntervalS && intervals.nightIntervalS === search.nightIntervalS,
  )?.[0];
  if (preset === undefined) return `${String(search.dayIntervalS)} s / ${String(search.nightIntervalS)} s`;
  return preset.charAt(0).toUpperCase() + preset.slice(1);
}

// Spec 8.3 /budget, for every signed-in person.
export function budgetRoutes(deps: BudgetPageDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/", async (c) => {
    const now = deps.clock.now();
    const [plan, searches, used, claude, { settings }] = await Promise.all([
      storedCallPlan(deps.pool, deps.settingsEnv),
      liveSearches(deps.pool),
      quotaUsed(deps.pool, now),
      claudeCallsToday(deps.pool, now),
      loadSettings(deps.pool, deps.settingsEnv),
    ]);
    const limit = settings.claudeDailyCallLimit;
    return c.html(
      renderPage(c, deps, {
        title: "Budget",
        active: "budget",
        children: (
          <>
            <PageHeader title="Budget" description="Planned eBay calls a day, worst case, checked on every save." />
            <Meter
              label="Planned eBay calls a day"
              value={plan.total}
              max={plan.ceiling}
              caption={`${count(Math.max(plan.ceiling - plan.total, 0))} calls a day left of ${count(plan.ceiling)}.`}
            />
            <Meter
              label="eBay calls used in this quota window"
              value={used}
              max={QUOTA_HARD_CAP}
              caption="The worker stops polls at 3,500 and every call at 4,000 of eBay's 5,000 a day."
            />
            <Table<PlanLine>
              caption="Daily call plan by line"
              columns={[
                { key: "label", label: "Line", rowHeader: true },
                { key: "calls", label: "Calls a day", numeric: true, render: (line) => count(line.calls) },
              ]}
              rows={planLines(plan)}
            />
            <Table<SearchListing>
              caption="Searches"
              columns={[
                { key: "id", label: "Search", rowHeader: true, mono: true },
                { key: "category", label: "Category", render: (search) => search.categoryName ?? search.categoryId },
                { key: "q", label: "Query", mono: true },
                { key: "speed", label: "Speed", render: speedOf },
                { key: "products", label: "Products", render: (search) => search.products.join(", ") },
                { key: "lastPoll", label: "Last poll", render: (search) => (search.lastPollAt === null ? "Never" : formatWhen(search.lastPollAt, now)) },
              ]}
              rows={searches}
              empty="No searches yet. A search appears when a product is activated."
            />
            <Table<ProductCalls>
              caption="Claude checks per product today"
              columns={[
                { key: "product", label: "Product", rowHeader: true, render: (row) => row.name ?? row.key },
                { key: "calls", label: "Claude checks today", numeric: true, render: (row) => count(row.calls) },
              ]}
              rows={claude}
              empty="No Claude checks today."
            />
            <p class={T.bodySm}>
              {`While two or more products are active, one product gets at most ${count(Math.ceil(limit / 2))} of the ${count(limit)} Claude checks a day.`}
            </p>
          </>
        ),
      }),
    );
  });

  return routes;
}
