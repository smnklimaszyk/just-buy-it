import { loadSettings, openDeals, overviewStatus, type DbPool, type Deal } from "@ebay-sniper/db";
import { formatUsd, type Clock, type SettingsEnv } from "@ebay-sniper/domain";
import { Hono } from "hono";
import type { AppEnv } from "../../session.js";
import { renderPage } from "../../shell.js";
import type { AssetManifest } from "../../ui/assets.js";
import { StatTile, Table } from "../../ui/data.js";
import { Meter } from "../../ui/feedback.js";
import { PageHeader } from "../../ui/navigation.js";
import { T } from "../../ui/shared.js";
import { ClaudeCell, EbayLink, LimitCell, listingTitle, marketText, priceText, productLabel, whenText } from "../deals/views.js";
import { PlatformBanners, PlatformState } from "./views.js";

// What the overview needs from the app. The .env ceilings bound the Claude caps it shows.
export type OverviewPageDeps = { pool: DbPool; clock: Clock; assets: AssetManifest; settingsEnv: SettingsEnv };

const count = (n: number): string => n.toLocaleString("en-US");

// reserve_ebay_call refuses every call at 80 % of eBay's 5,000 a day (spec 1.3), as on /budget.
const QUOTA_HARD_CAP = 4_000;

// Spec 8.3 /, for every signed-in person.
export function overviewRoutes(deps: OverviewPageDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/", async (c) => {
    const now = deps.clock.now();
    const [deals, status, { settings, warnings }] = await Promise.all([
      openDeals(deps.pool, now),
      overviewStatus(deps.pool, now),
      // The caps in force: the stored settings bounded by the .env ceilings.
      loadSettings(deps.pool, deps.settingsEnv),
    ]);
    return c.html(
      renderPage(c, deps, {
        title: "Overview",
        active: "overview",
        // ?auto=1 marks the reload as automatic, so it does not keep the session alive (spec 7.4).
        refresh: { seconds: 60, url: "/?auto=1" },
        children: (
          <>
            <PageHeader title="Overview" />
            <section class="app-stack" aria-labelledby="open-deals">
              <h2 id="open-deals" class={T.titleSm}>
                Open deals
              </h2>
              {/* Without deals a sentence, not an empty table a phone scrolls sideways. */}
              {deals.length === 0 ? (
                <p class={T.body}>No deals in the last 24 hours.</p>
              ) : (
                <Table<Deal>
                  caption="Open deals of the last 24 hours"
                  columns={[
                    { key: "product", label: "Product", rowHeader: true, render: productLabel },
                    { key: "listing", label: "Listing", render: listingTitle },
                    { key: "price", label: "Price", numeric: true, render: priceText },
                    { key: "limit", label: "Limit", numeric: true, render: (deal) => <LimitCell deal={deal} /> },
                    { key: "market", label: "Market", render: marketText },
                    { key: "claude", label: "Claude", render: (deal) => <ClaudeCell deal={deal} /> },
                    { key: "when", label: "When", render: (deal) => whenText(deal, now) },
                    { key: "ebay", label: "eBay", render: (deal) => <EbayLink deal={deal} /> },
                  ]}
                  rows={deals}
                />
              )}
            </section>
            <section class="app-stack" aria-labelledby="today">
              <h2 id="today" class={T.titleSm}>
                Today
              </h2>
              <div class="app-row">
                <StatTile label="Deals today" value={count(status.dealsToday)} />
                <StatTile label="Candidates today" value={count(status.candidatesToday)} />
                <StatTile label="eBay calls today" value={count(status.ebayCallsToday)} />
                <StatTile label="Claude spend today" value={formatUsd(status.claude.spentMicrousd)} />
              </div>
              <Meter
                label="eBay calls used in this quota window"
                value={status.quotaUsed}
                max={QUOTA_HARD_CAP}
                caption="The worker stops polls at 3,500 and every call at 4,000 of eBay's 5,000 a day."
              />
              {settings.claudeDailyCallLimit === 0 || settings.claudeDailySpendLimitMicrousd === 0 ? (
                <p class={T.body}>{`The Claude check is off: the daily ${settings.claudeDailyCallLimit === 0 ? "call limit" : "spend cap"} is 0.`}</p>
              ) : (
                <>
                  <Meter label="Claude checks today" value={status.claude.calls} max={settings.claudeDailyCallLimit} />
                  <Meter label="Claude spend today" value={status.claude.spentMicrousd} max={settings.claudeDailySpendLimitMicrousd} format={formatUsd} />
                </>
              )}
            </section>
            <section class="app-stack" aria-labelledby="platform">
              <h2 id="platform" class={T.titleSm}>
                Worker and searches
              </h2>
              <PlatformState worker={status.worker} searches={status.searches} now={now} />
              <PlatformBanners
                input={{
                  warnings,
                  screeningPausedUntil: status.screeningPausedUntil,
                  smtpPausedUntil: status.smtpPausedUntil,
                  claude: status.claude,
                  callLimit: settings.claudeDailyCallLimit,
                  spendLimitMicrousd: settings.claudeDailySpendLimitMicrousd,
                }}
              />
            </section>
          </>
        ),
      }),
    );
  });

  return routes;
}
