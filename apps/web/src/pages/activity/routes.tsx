import type { DbPool } from "@ebay-sniper/db";
import type { Clock } from "@ebay-sniper/domain";
import { Hono } from "hono";
import { shortIp } from "../../auth/ip.js";
import type { AppEnv } from "../../session.js";
import { renderPage } from "../../shell.js";
import type { AssetManifest } from "../../ui/assets.js";
import { Button } from "../../ui/core.js";
import { Table } from "../../ui/data.js";
import { Select } from "../../ui/forms.js";
import { PageHeader, Pagination } from "../../ui/navigation.js";
import { formatWhen } from "../products/format.js";
import { ACTIVITY_PAGE_SIZE, activityEvents, activityPage, type ActivityRow } from "./queries.js";

// What the Activity page needs from the app.
export type ActivityPageDeps = { pool: DbPool; clock: Clock; assets: AssetManifest };

const SYSTEM_ACTORS: Record<string, string> = {
  "system:cli": "ops CLI",
  "system:bootstrap": "Bootstrap from .env",
  "system:import": "Legacy import",
};

// Who did it: the person, the system part, or the address that is no person.
function whoOf(row: ActivityRow): string {
  if (row.email !== null) return row.email;
  if (row.actor !== null) return SYSTEM_ACTORS[row.actor] ?? row.actor;
  return "Unknown address";
}

// The detail object as "key: value" pairs. Text only: JSX escapes it.
function detailOf(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

// Spec 8.3 /activity, admins only (the session guard sends editors a 403).
export function activityRoutes(deps: ActivityPageDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/", async (c) => {
    const now = deps.clock.now();
    const kindParam = c.req.query("kind");
    const kind = kindParam === "audit" || kindParam === "auth" ? kindParam : null;
    const events = await activityEvents(deps.pool);
    const event = events.find((name) => name === c.req.query("event")) ?? null;
    const pageParam = c.req.query("page") ?? "";
    const page = /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1;
    const { rows, total } = await activityPage(deps.pool, { kind, event }, page);
    const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
    // The filter stays on every page link.
    const filter = new URLSearchParams([...(kind === null ? [] : [["kind", kind]]), ...(event === null ? [] : [["event", event]])]);
    filter.set("page", "");
    return c.html(
      renderPage(c, deps, {
        title: "Activity",
        active: "activity",
        children: (
          <>
            <PageHeader title="Activity" description="Changes are kept a year, sign-in events 90 days." />
            <form method="get" action="/activity" class="app-row">
              <Select
                id="activity-kind"
                name="kind"
                aria-label="Kind"
                value={kind ?? ""}
                options={[
                  { value: "", label: "All kinds" },
                  { value: "audit", label: "Change" },
                  { value: "auth", label: "Sign-in" },
                ]}
              />
              <Select
                id="activity-event"
                name="event"
                aria-label="Event"
                value={event ?? ""}
                options={[{ value: "", label: "All events" }, ...events.map((name) => ({ value: name, label: name }))]}
              />
              <Button type="submit">Filter</Button>
            </form>
            <Table<ActivityRow>
              caption="Activity, newest first"
              columns={[
                { key: "at", label: "When", render: (row) => formatWhen(row.at, now) },
                { key: "source", label: "Kind", render: (row) => (row.source === "audit" ? "Change" : "Sign-in") },
                { key: "event", label: "Event", mono: true },
                { key: "who", label: "Who", render: whoOf },
                { key: "ip", label: "Network", mono: true, render: (row) => shortIp(row.ip) ?? "" },
                { key: "detail", label: "Details", render: (row) => detailOf(row.detail) },
              ]}
              rows={rows}
              empty="Nothing happened yet."
            />
            {total > ACTIVITY_PAGE_SIZE && (
              <Pagination page={page} pageCount={pageCount} total={total} pageSize={ACTIVITY_PAGE_SIZE} href={`/activity?${filter.toString()}`} />
            )}
          </>
        ),
      }),
    );
  });

  return routes;
}
