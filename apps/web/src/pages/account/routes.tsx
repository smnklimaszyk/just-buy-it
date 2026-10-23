import { listSessions, signOutEverywhere, type SessionListing } from "@ebay-sniper/db";
import { berlinDay, formatBerlinTime } from "@ebay-sniper/domain";
import { Hono } from "hono";
import type { AppDeps } from "../../app.js";
import { clearSessionCookie } from "../../auth/cookies.js";
import { clientIp, shortIp } from "../../auth/ip.js";
import type { AppEnv } from "../../session.js";
import { renderPage } from "../../shell.js";
import { Button } from "../../ui/core.js";
import { Table } from "../../ui/data.js";
import { PageHeader } from "../../ui/navigation.js";

const when = (at: Date): string => `${formatBerlinTime(at)}, ${berlinDay(at)}`;

// What people see of a user agent: enough to tell their browsers apart.
const browserOf = (userAgent: string | null): string => (userAgent === null ? "Unknown browser" : userAgent.slice(0, 80));

// GET /account (spec 8.3, auth.md 9): the person's own sessions, with the IP shortened.
export function accountRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/", async (c) => {
    const session = c.get("session");
    if (session === null) throw new Error("the account page needs a session");
    const sessions = await listSessions(deps.pool, session.person.id, deps.clock.now());
    return c.html(
      renderPage(c, deps, {
        title: "Account",
        active: "account",
        children: (
          <>
            <PageHeader title="Account" description={session.person.email} />
            <Table<SessionListing>
              caption="Your sessions"
              columns={[
                { key: "browser", label: "Browser", rowHeader: true, render: (row) => (row.id === session.session.id ? "This browser" : browserOf(row.userAgent)) },
                { key: "ip", label: "Network", mono: true, render: (row) => shortIp(row.ip) ?? "Not recorded" },
                { key: "created", label: "Signed in", render: (row) => when(row.createdAt) },
                { key: "seen", label: "Last seen", render: (row) => when(row.lastSeenAt) },
              ]}
              rows={sessions}
            />
            <form method="post" action="/account/sign-out-everywhere" class="app-row">
              <input type="hidden" name="_csrf" value={session.session.csrfSecret} />
              <Button type="submit" variant="primary">
                Sign out everywhere
              </Button>
            </form>
          </>
        ),
      }),
    );
  });

  // ASVS 7.4.1: every session of the person ends, this one too, so the browser signs in again.
  routes.post("/sign-out-everywhere", async (c) => {
    const session = c.get("session");
    if (session === null) throw new Error("signing out everywhere needs a session");
    await signOutEverywhere(deps.pool, { userId: session.person.id, at: deps.clock.now(), ip: clientIp(c.req.header("x-forwarded-for")) });
    clearSessionCookie(c);
    return c.redirect("/login", 303);
  });

  return routes;
}
