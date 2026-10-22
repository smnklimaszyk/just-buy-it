import type {
  AlertRow,
  BlockedRow,
  CandidatesPage,
  Overview,
  PricesRow,
  Queryable,
  RejectionsPage,
  ScreeningRow,
} from "@ebay-sniper/db";
import { describe, expect, it } from "vitest";
import { createDashboardApp, dashboardData, type DashboardData } from "./dashboard.js";
import { alertsHtml, blockedHtml, candidatesHtml, overviewHtml, rejectionsHtml } from "./dashboard-html.js";

const gitSha = "0123456789abcdef0123456789abcdef01234567";
// 14:40 CEST
const now = new Date("2026-10-21T12:40:00Z");
const clock = { now: () => now };

const overview: Overview = {
  worker: {
    gitSha,
    startedAt: new Date("2026-10-21T08:00:00Z"),
    heartbeatAt: new Date("2026-10-21T12:39:50Z"),
    smtpConfigured: true,
    claudeConfigured: false,
  },
  feeds: [
    {
      id: "gpu",
      enabled: true,
      baselineDone: true,
      // Running since 6 minutes: stale.
      lastPoll: {
        startedAt: new Date("2026-10-21T12:34:00Z"),
        status: "error",
        stale: true,
        items: 0,
        newItems: 0,
        candidates: 0,
        warningIds: [],
      },
      failedInRow: 3,
      capReachedLast24h: 1,
    },
    {
      id: "ram",
      enabled: false,
      baselineDone: false,
      lastPoll: {
        startedAt: new Date("2026-10-21T12:38:00Z"),
        status: "ok",
        stale: false,
        items: 187,
        newItems: 4,
        candidates: 1,
        warningIds: [12017],
      },
      failedInRow: 0,
      capReachedLast24h: 0,
    },
    { id: "pc", enabled: false, baselineDone: false, lastPoll: null, failedInRow: 0, capReachedLast24h: 0 },
  ],
  sweeps: [
    {
      segment: "gpu_3090",
      lastSweep: { startedAt: new Date("2026-10-21T12:05:00Z"), status: "ok", stale: false, items: 33, candidates: 2 },
    },
    { segment: "ram_ddr5", lastSweep: null },
  ],
  quota: [
    {
      resource: "buy.browse",
      windowStart: new Date("2026-10-21T07:00:00Z"),
      windowEnd: new Date("2026-10-22T07:00:00Z"),
      limitTotal: 5000,
      used: 431,
      usedAlertPath: 9,
      usedStandard: 422,
    },
  ],
  callsToday: [{ resource: "buy.browse", purpose: "poll", calls: 377 }],
  claudeToday: {
    day: "2026-10-21",
    calls: 7,
    reservedMicrousd: 62_000,
    spentMicrousd: 153_400,
    failures: [{ code: "timeout", count: 2 }],
    pausedUntil: null,
  },
  email: {
    pending: [{ holdReason: "smtp_not_configured", count: 3 }],
    sent24h: 5,
    failed24h: 1,
    pausedUntil: new Date("2026-10-21T12:50:00Z"),
  },
  lastPurge: {
    startedAt: new Date("2026-10-21T12:30:00Z"),
    finishedAt: new Date("2026-10-21T12:30:02Z"),
    status: "ok",
    counts: { listing_content: 14, seen_item: 0 },
  },
};

const hostile = `<script>alert("x")</script> & 'quoted'`;
const escapedHostile = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;";

const candidates: CandidatesPage = {
  candidates: [
    {
      createdAt: new Date("2026-10-21T12:32:00Z"),
      segment: "gpu_3090",
      title: hostile,
      priceCents: 45_900,
      shippingCents: 3_000,
      landedCents: 48_900,
      percentOfMax: 94,
      flags: ["mining_history", "best_offer"],
      decision: "alerted",
      rejectReason: null,
      verdict: "pass",
      legacyItemId: "123456789012",
    },
    {
      createdAt: new Date("2026-10-21T11:00:00Z"),
      segment: "ram_ddr5",
      title: null,
      priceCents: 16_500,
      shippingCents: null,
      landedCents: null,
      percentOfMax: 92,
      flags: ["shipping_unknown"],
      decision: "rejected_after_enrich",
      rejectReason: "ram_server",
      verdict: null,
      legacyItemId: null,
    },
  ],
  today: [{ segment: "gpu_3090", candidates: 4, cap: 150, overCap: 0, tooOld: 6 }],
};

const alerts: AlertRow[] = [
  {
    createdAt: new Date("2026-10-21T12:33:00Z"),
    segment: "gpu_4090",
    landedCents: 118_000,
    finalVerdict: "caution",
    modelVerdict: null,
    blockedByCode: false,
    screened: false,
    deliveryStatus: "pending",
    holdReason: "rate_limit",
    attempt: 0,
    lastErrorCode: "ETIMEDOUT",
    sentAt: null,
  },
  {
    createdAt: new Date("2026-10-21T10:00:00Z"),
    segment: "gpu_3090",
    landedCents: 30_000,
    finalVerdict: "block",
    modelVerdict: "block",
    blockedByCode: true,
    screened: true,
    deliveryStatus: null,
    holdReason: null,
    attempt: null,
    lastErrorCode: null,
    sentAt: null,
  },
];

const blocked: BlockedRow[] = [
  {
    alertId: "0199f000-0000-7000-8000-000000000001",
    createdAt: new Date("2026-10-21T10:00:00Z"),
    segment: "gpu_3090",
    landedCents: 30_000,
    flags: ["low_feedback"],
    riskFlags: ["off_ebay_payment"],
    codeSignals: ["iban_present"],
    blockedByCode: true,
    reason: hostile,
    legacyItemId: `1"><script>`,
  },
  {
    alertId: "0199f000-0000-7000-8000-000000000002",
    createdAt: new Date("2026-10-20T10:00:00Z"),
    segment: "gpu_4090",
    landedCents: null,
    flags: [],
    riskFlags: [],
    codeSignals: [],
    blockedByCode: false,
    reason: null,
    legacyItemId: null,
  },
];

const screenings: ScreeningRow[] = [
  {
    createdAt: new Date("2026-10-21T12:34:00Z"),
    status: "done",
    verdict: "caution",
    riskFlags: ["mining_history"],
    failureCode: null,
    requestBytes: 6_210,
    inputTokens: 2_480,
    outputTokens: 912,
    costMicrousd: 14_080,
    latencyMs: 8_412,
    model: "claude-sonnet-5-5",
  },
  {
    createdAt: new Date("2026-10-21T12:00:00Z"),
    status: "failed",
    verdict: null,
    riskFlags: [],
    failureCode: "timeout",
    requestBytes: 5_000,
    inputTokens: null,
    outputTokens: null,
    costMicrousd: null,
    latencyMs: null,
    model: "claude-sonnet-5-5",
  },
];

const rejections: RejectionsPage = {
  counts: [
    { feedId: "gpu", outcome: "above_max", count: 140 },
    { feedId: "gpu", outcome: "candidate", count: 3 },
  ],
  samples: [
    {
      feedId: "gpu",
      segment: null,
      title: hostile,
      landedCents: 9_900,
      outcome: "rejected",
      reason: "accessory",
      seenAt: new Date("2026-10-21T12:20:00Z"),
    },
    {
      feedId: "ram",
      segment: "ram_ddr4",
      title: "2x16GB DDR4 3200",
      landedCents: null,
      outcome: "candidate",
      reason: null,
      seenAt: new Date("2026-10-21T12:21:00Z"),
    },
  ],
};

const prices: PricesRow[] = [
  {
    segment: "gpu_3090",
    feedId: "gpu",
    current: { kind: "per_item", maxLandedCents: 52_000, floorCents: 26_000 },
    windows: [
      {
        window: "since_baseline",
        since: new Date("2026-10-21T09:00:00Z"),
        stats: { n: 42, p25: 58_000.5, p50: 65_000, p75: 72_000, landedP75: 72_000 },
        suggestion: { kind: "per_item", maxLandedCents: 52_000, floorCents: 26_000 },
      },
      {
        window: "last_24h",
        since: new Date("2026-10-20T12:40:00Z"),
        stats: { n: 0, p25: null, p50: null, p75: null, landedP75: null },
        suggestion: { kind: "none", reason: "too_few" },
      },
    ],
  },
  {
    segment: "ram_ddr4",
    feedId: "ram",
    current: { kind: "per_gb", maxCentsPerGb: 320, minCentsPerGb: 160 },
    windows: [
      {
        window: "since_baseline",
        since: new Date(0),
        stats: { n: 30, p25: 380, p50: 410.4, p75: 450, landedP75: 115_000 },
        suggestion: { kind: "none", reason: "cut_off" },
      },
      {
        window: "last_7d",
        since: new Date("2026-10-14T12:40:00Z"),
        stats: { n: 25, p25: 380, p50: 410, p75: 450, landedP75: 30_000 },
        suggestion: { kind: "per_gb", maxCentsPerGb: 320, minCentsPerGb: 160 },
      },
    ],
  },
];

const unused = async (): Promise<never> => {
  throw new Error("not used in this test");
};

const fullData: DashboardData = {
  overview: unused,
  candidates: unused,
  alerts: unused,
  blocked: unused,
  screenings: unused,
  rejections: unused,
  prices: unused,
};

function dashboard(data: Partial<DashboardData> = {}) {
  const logged: Record<string, unknown>[] = [];
  const app = createDashboardApp({
    data: { ...fullData, ...data },
    clock,
    gitSha,
    log: { error: (entry) => logged.push(entry) },
  });
  return { app, logged };
}

describe("dashboard listener", () => {
  it("answers /healthz with the running commit", async () => {
    const res = await dashboard().app.request("/healthz");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(`{"sha":"${gitSha}"}`);
  });

  it("serves none of the public paths and no write method", async () => {
    const { app } = dashboard({ overview: async () => overview });

    expect((await app.request("/ebay/account-deletion?challenge_code=x")).status).toBe(404);
    expect((await app.request("/privacy")).status).toBe(404);
    expect((await app.request("/internal/listings")).status).toBe(404);
    expect((await app.request("/", { method: "POST" })).status).toBe(404);
  });

  it("serves the overview as uncached HTML that refreshes every minute and runs no script", async () => {
    const res = await dashboard({ overview: async () => overview }).app.request("/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain(`<meta http-equiv="refresh" content="60">`);
    expect(html).toContain("As of 14:40 CEST, 21 Oct 2026");
    expect(html).not.toMatch(/<script/i);
  });
});

describe("every page", () => {
  const PATHS = ["/", "/candidates", "/alerts", "/blocked", "/screenings", "/rejections", "/prices"];
  const data: DashboardData = {
    overview: async () => overview,
    candidates: async () => candidates,
    alerts: async () => alerts,
    blocked: async () => blocked,
    screenings: async () => screenings,
    rejections: async () => rejections,
    prices: async () => prices,
  };

  it.each(PATHS)("%s is uncached, refreshes every minute, runs no script and links every page", async (path) => {
    const res = await dashboard(data).app.request(path);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain(`<meta http-equiv="refresh" content="60">`);
    expect(html).toContain("As of 14:40 CEST, 21 Oct 2026");
    expect(html).not.toMatch(/<script/i);
    for (const link of PATHS) expect(html).toContain(`<a href="${link}">`);
  });

  it("answers 500 without the error text when a query fails, and logs only the error code", async () => {
    const failure = Object.assign(new Error(`canceling statement due to statement timeout ${hostile}`), { code: "57014" });
    const { app, logged } = dashboard({
      ...data,
      candidates: async () => {
        throw failure;
      },
    });

    const res = await app.request("/candidates");
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toBe("Dashboard query failed");
    expect(logged).toEqual([{ event: "dashboard_page_failed", path: "/candidates", err_code: "57014" }]);
  });
});

describe("dashboardData", () => {
  it("runs every page query on the pool it is given, with the request time", async () => {
    const statements: { text: string; values: unknown }[] = [];
    const db = {
      query: async (text: string, values?: unknown) => {
        statements.push({ text, values });
        return { rows: [] };
      },
    } as unknown as Queryable;
    const data = dashboardData(db);

    await data.overview(now);
    await data.candidates(now);
    await data.alerts(now);
    await data.blocked(now);
    await data.screenings(now);
    await data.rejections(now);
    await data.prices(now);

    for (const table of ["app.worker_status", "app.candidate c", "app.alert a", "ebay_live.screening_text", "app.screening WHERE", "ebay_live.classifier_sample", "AND baseline"]) {
      expect(statements.some((s) => s.text.includes(table))).toBe(true);
    }
    expect(statements.find((s) => s.text.includes("app.alert a"))?.values).toEqual([now, 100]);
  });
});

async function page(path: string, data: Partial<DashboardData>): Promise<string> {
  const res = await dashboard(data).app.request(path);
  expect(res.status).toBe(200);
  return res.text();
}

describe("overview page", () => {
  it("shows the worker status in Berlin time", async () => {
    const html = await page("/", { overview: async () => overview });

    expect(html).toContain(gitSha);
    expect(html).toContain("21 Oct 10:00 CEST");
    expect(html).toContain("21 Oct 14:39 CEST");
    expect(html).toContain("<tr><th>SMTP configured</th><td>yes</td></tr>");
    expect(html).toContain("<tr><th>Claude configured</th><td>no</td></tr>");
  });

  it("shows each feed's last poll, a stale running poll as error (stale), and the failures in a row", async () => {
    const html = await page("/", { overview: async () => overview });

    expect(html).toContain(
      "<tr><td>gpu</td><td>yes</td><td>yes</td><td>21 Oct 14:34 CEST</td><td>error (stale)</td><td>0</td><td>0</td><td>0</td><td>none</td><td>3</td><td>1</td></tr>",
    );
    expect(html).toContain(
      "<tr><td>ram</td><td>no</td><td>no</td><td>21 Oct 14:38 CEST</td><td>ok</td><td>187</td><td>4</td><td>1</td><td>12017</td><td>0</td><td>0</td></tr>",
    );
    expect(html).toContain("<tr><td>pc</td><td>no</td><td>no</td><td>never</td>");
  });

  it("shows the last sweep per segment, the eBay quota window and today's calls by purpose", async () => {
    const html = await page("/", { overview: async () => overview });

    expect(html).toContain("<tr><td>RTX 3090</td><td>21 Oct 14:05 CEST</td><td>ok</td><td>33</td><td>2</td></tr>");
    expect(html).toContain("<tr><td>DDR5</td><td>never</td><td>-</td><td>-</td><td>-</td></tr>");
    expect(html).toContain(
      "<tr><td>buy.browse</td><td>21 Oct 09:00 CEST to 22 Oct 09:00 CEST</td><td>431 / 5000</td><td>9</td><td>422</td></tr>",
    );
    expect(html).toContain("<tr><td>buy.browse</td><td>poll</td><td>377</td></tr>");
  });

  it("shows today's Claude use, the email deliveries and the last purge", async () => {
    const html = await page("/", { overview: async () => overview });

    expect(html).toContain("<tr><th>Calls (2026-10-21)</th><td>7</td></tr>");
    expect(html).toContain("<tr><th>Spent</th><td>USD 0.15</td></tr>");
    expect(html).toContain("<tr><th>Reserved</th><td>USD 0.06</td></tr>");
    expect(html).toContain("<tr><th>Screening paused until</th><td>not paused</td></tr>");
    expect(html).toContain("<tr><td>timeout</td><td>2</td></tr>");
    expect(html).toContain("<tr><td>smtp_not_configured</td><td>3</td></tr>");
    expect(html).toContain("<tr><th>Sent (24 h)</th><td>5</td></tr>");
    expect(html).toContain("<tr><th>Failed (24 h)</th><td>1</td></tr>");
    expect(html).toContain("<tr><th>SMTP paused until</th><td>21 Oct 14:50 CEST</td></tr>");
    expect(html).toContain("<tr><th>Counts</th><td>listing_content: 14, seen_item: 0</td></tr>");
  });

  it("says when the worker never reported and no purge ran yet", async () => {
    const html = await page("/", { overview: async () => ({ ...overview, worker: null, lastPurge: null }) });

    expect(html).toContain("No worker status yet.");
    expect(html).toContain("No purge run yet.");
  });
});

// Rows v2 writes carry product keys where a segment stood and the decisions wrong_product and held.
describe("rows v2 wrote", () => {
  it("show the product key and the decision as stored on every page that lists them", async () => {
    const key = "p_k3x9ab2cde";
    const [firstCandidate] = candidates.candidates;
    const [firstAlert] = alerts;
    const [firstBlocked] = blocked;
    const [firstSample] = rejections.samples;
    if (firstCandidate === undefined || firstAlert === undefined || firstBlocked === undefined || firstSample === undefined) {
      throw new Error("fixtures changed");
    }
    const candidatesPage = candidatesHtml(
      {
        ...candidates,
        candidates: [
          { ...firstCandidate, segment: key, decision: "wrong_product" },
          { ...firstCandidate, segment: key, decision: "held" },
        ],
      },
      now,
    );

    expect(overviewHtml({ ...overview, sweeps: [...overview.sweeps, { segment: key, lastSweep: null }] }, now)).toContain(
      `<tr><td>${key}</td><td>never</td>`,
    );
    expect(candidatesPage).toContain(`<td>${key}</td>`);
    expect(candidatesPage).toContain("<td>wrong_product</td>");
    expect(candidatesPage).toContain("<td>held</td>");
    expect(alertsHtml([{ ...firstAlert, segment: key }], now)).toContain(`<td>${key}</td>`);
    expect(blockedHtml([{ ...firstBlocked, segment: key }], now)).toContain(`<td>${key}</td>`);
    expect(rejectionsHtml({ ...rejections, samples: [{ ...firstSample, segment: key }] }, now)).toContain(`<td>${key}</td>`);
  });
});

describe("candidates page", () => {
  it("escapes the title and links the item on eBay while its content exists", async () => {
    const html = await page("/candidates", { candidates: async () => candidates });

    expect(html).not.toContain(hostile);
    expect(html).toContain(
      `<tr><td>21 Oct 14:32 CEST</td><td>RTX 3090</td><td>${escapedHostile}</td><td>EUR 459.00</td><td>EUR 30.00</td><td>EUR 489.00</td><td>94%</td><td>mining_history, best_offer</td><td>alerted</td><td>-</td><td>pass</td><td><a href="https://www.ebay.de/itm/123456789012">eBay</a></td></tr>`,
    );
  });

  it("shows expired content without title or link, unknown shipping as unknown, and today's counts against the cap", async () => {
    const html = await page("/candidates", { candidates: async () => candidates });

    expect(html).toContain(
      "<tr><td>21 Oct 13:00 CEST</td><td>DDR5</td><td>content expired</td><td>EUR 165.00</td><td>unknown</td><td>unknown</td><td>92%</td><td>shipping_unknown</td><td>rejected_after_enrich</td><td>ram_server</td><td>-</td><td>-</td></tr>",
    );
    expect(html).toContain("<tr><td>RTX 3090</td><td>4 / 150</td><td>0</td><td>6</td></tr>");
  });
});

describe("alerts page", () => {
  it("shows the verdicts and the delivery state, and an alert blocked by code without a delivery", async () => {
    const html = await page("/alerts", { alerts: async () => alerts });

    expect(html).toContain(
      "<tr><td>21 Oct 14:33 CEST</td><td>RTX 4090</td><td>EUR 1,180.00</td><td>caution</td><td>not screened</td><td>no</td><td>no</td><td>pending</td><td>rate_limit</td><td>0</td><td>ETIMEDOUT</td><td>-</td></tr>",
    );
    expect(html).toContain(
      "<tr><td>21 Oct 12:00 CEST</td><td>RTX 3090</td><td>EUR 300.00</td><td>block</td><td>block</td><td>yes</td><td>yes</td><td>no delivery</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>",
    );
  });
});

describe("blocked page", () => {
  it("shows the signals and the escaped reason, encodes the item ID in the link, and hides expired content", async () => {
    const html = await page("/blocked", { blocked: async () => blocked });

    expect(html).not.toContain(`"><script>`);
    expect(html).toContain(
      `<tr><td>21 Oct 12:00 CEST</td><td>RTX 3090</td><td>EUR 300.00</td><td>low_feedback</td><td>off_ebay_payment</td><td>iban_present</td><td>yes</td><td>${escapedHostile}</td><td><a href="https://www.ebay.de/itm/1%22%3E%3Cscript%3E">eBay</a></td></tr>`,
    );
    expect(html).toContain(
      "<tr><td>20 Oct 12:00 CEST</td><td>RTX 4090</td><td>-</td><td>none</td><td>none</td><td>none</td><td>no</td><td>content expired</td><td>-</td></tr>",
    );
  });
});

describe("screenings page", () => {
  it("shows status, verdict, failure code, bytes, tokens, cost, latency and model", async () => {
    const html = await page("/screenings", { screenings: async () => screenings });

    expect(html).toContain(
      "<tr><td>21 Oct 14:34 CEST</td><td>done</td><td>caution</td><td>mining_history</td><td>-</td><td>6210</td><td>2480</td><td>912</td><td>USD 0.0141</td><td>8412 ms</td><td>claude-sonnet-5-5</td></tr>",
    );
    expect(html).toContain(
      "<tr><td>21 Oct 14:00 CEST</td><td>failed</td><td>-</td><td>none</td><td>timeout</td><td>5000</td><td>-</td><td>-</td><td>-</td><td>-</td><td>claude-sonnet-5-5</td></tr>",
    );
  });
});

describe("rejections page", () => {
  it("shows the 24-hour counts by feed and reason and the escaped sample titles", async () => {
    const html = await page("/rejections", { rejections: async () => rejections });

    expect(html).not.toContain(hostile);
    expect(html).toContain("<tr><td>gpu</td><td>above_max</td><td>140</td></tr>");
    expect(html).toContain(
      `<tr><td>21 Oct 14:20 CEST</td><td>gpu</td><td>-</td><td>rejected</td><td>accessory</td><td>EUR 99.00</td><td>${escapedHostile}</td></tr>`,
    );
    expect(html).toContain(
      "<tr><td>21 Oct 14:21 CEST</td><td>ram</td><td>DDR4</td><td>candidate</td><td>-</td><td>-</td><td>2x16GB DDR4 3200</td></tr>",
    );
  });
});

describe("prices page", () => {
  it("shows per window n, quartiles and the suggestion or the reason there is none, next to the current rule", async () => {
    const html = await page("/prices", { prices: async () => prices });

    expect(html).toContain("<p>Current: max EUR 520.00, floor EUR 260.00</p>");
    expect(html).toContain(
      "<tr><td>since baseline (21 Oct 11:00 CEST)</td><td>42</td><td>EUR 580.01</td><td>EUR 650.00</td><td>EUR 720.00</td><td>max EUR 520.00, floor EUR 260.00</td></tr>",
    );
    expect(html).toContain("<tr><td>last 24 h</td><td>0</td><td>-</td><td>-</td><td>-</td><td>none: fewer than 20 samples</td></tr>");
    expect(html).toContain("<p>Current: max EUR 3.20/GB, floor EUR 1.60/GB</p>");
    expect(html).toContain(
      "<tr><td>since baseline (no baseline yet)</td><td>30</td><td>EUR 3.80/GB</td><td>EUR 4.10/GB</td><td>EUR 4.50/GB</td><td>none: the read is cut off, raise the read ceiling</td></tr>",
    );
    expect(html).toContain(
      "<tr><td>last 7 days</td><td>25</td><td>EUR 3.80/GB</td><td>EUR 4.10/GB</td><td>EUR 4.50/GB</td><td>max EUR 3.20/GB, floor EUR 1.60/GB</td></tr>",
    );
  });
});
