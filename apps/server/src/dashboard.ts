import {
  alertsPage,
  blockedPage,
  candidatesPage,
  overviewPage,
  pricesPage,
  rejectionsPage,
  screeningsPage,
  type AlertRow,
  type BlockedRow,
  type CandidatesPage,
  type Overview,
  type PricesRow,
  type Queryable,
  type RejectionsPage,
  type ScreeningRow,
} from "@ebay-sniper/db";
import type { Clock } from "@ebay-sniper/domain";
import { Hono } from "hono";
import {
  alertsHtml,
  blockedHtml,
  candidatesHtml,
  overviewHtml,
  pricesHtml,
  rejectionsHtml,
  screeningsHtml,
} from "./dashboard-html.js";
import type { LogFn } from "./notifications.js";

// The pages carry seller-written titles: the policy allows no script, form or frame at all.
const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

// The read-only page queries, each given the time of the request.
export type DashboardData = {
  overview(now: Date): Promise<Overview>;
  candidates(now: Date): Promise<CandidatesPage>;
  alerts(now: Date): Promise<AlertRow[]>;
  blocked(now: Date): Promise<BlockedRow[]>;
  screenings(now: Date): Promise<ScreeningRow[]>;
  rejections(now: Date): Promise<RejectionsPage>;
  prices(now: Date): Promise<PricesRow[]>;
};

// The page queries of packages/db on the dashboard pool (role dashboard, read-only, 2 s statement
// timeout). The deletion path keeps its own pool as role app.
export function dashboardData(db: Queryable): DashboardData {
  return {
    overview: (now) => overviewPage(db, now),
    candidates: (now) => candidatesPage(db, now),
    alerts: (now) => alertsPage(db, now),
    blocked: (now) => blockedPage(db, now),
    screenings: (now) => screeningsPage(db, now),
    rejections: (now) => rejectionsPage(db, now),
    prices: (now) => pricesPage(db, now),
  };
}

export type DashboardOptions = {
  data: DashboardData;
  clock: Clock;
  gitSha: string;
  log: { error: LogFn };
};

// Section 8: the internal dashboard on its own listener, never routed by Traefik.
export function createDashboardApp(options: DashboardOptions) {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ sha: options.gitSha }, 200, { "Cache-Control": "no-store" }));

  function page<T>(path: string, load: (now: Date) => Promise<T>, render: (data: T, now: Date) => string): void {
    app.get(path, async (c) => {
      const now = options.clock.now();
      return c.html(render(await load(now), now), 200, PAGE_HEADERS);
    });
  }

  // A failed query (for example the 2 s statement timeout) is logged by its code only: a database
  // error message can quote values, and Hono's default handler would print the whole error.
  app.onError((error, c) => {
    options.log.error({
      event: "dashboard_page_failed",
      path: c.req.path,
      err_code: "code" in error ? String(error.code) : error.name,
    });
    return c.text("Dashboard query failed", 500, { "Cache-Control": "no-store" });
  });

  const { data } = options;
  page("/", (now) => data.overview(now), overviewHtml);
  page("/candidates", (now) => data.candidates(now), candidatesHtml);
  page("/alerts", (now) => data.alerts(now), alertsHtml);
  page("/blocked", (now) => data.blocked(now), blockedHtml);
  page("/screenings", (now) => data.screenings(now), screeningsHtml);
  page("/rejections", (now) => data.rejections(now), rejectionsHtml);
  page("/prices", (now) => data.prices(now), pricesHtml);

  return app;
}
