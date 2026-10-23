import { addPerson, changeRole, disablePerson, endPersonSessions, listPeople, type AuthContext, type DbPool, type LoadedSession, type Person } from "@ebay-sniper/db";
import type { Clock } from "@ebay-sniper/domain";
import { Hono, type Context } from "hono";
import { normalizeAddress } from "../../auth/address.js";
import { signedInRecently, type AppEnv } from "../../session.js";
import { errorPage } from "../errors/views.js";
import { renderPage } from "../../shell.js";
import type { AssetManifest } from "../../ui/assets.js";
import { Button } from "../../ui/core.js";
import { Table } from "../../ui/data.js";
import { Badge, Banner } from "../../ui/feedback.js";
import { Input, RadioGroup } from "../../ui/forms.js";
import { Menu, PageHeader } from "../../ui/navigation.js";
import { ConfirmDialog, Dialog } from "../../ui/overlays.js";
import type { Child } from "../../ui/shared.js";
import { formatWhen } from "../products/format.js";
import { peopleActivity, type PersonActivity } from "./queries.js";

// What the People page needs from the app.
export type PeoplePageDeps = { pool: DbPool; clock: Clock; assets: AssetManifest };

// The session guard lets only admins through to these routes (spec 7.1).
function signedIn(c: Context<AppEnv>): LoadedSession {
  const session = c.get("session");
  if (session === null) throw new Error("the People page needs a session");
  return session;
}

type PersonRow = Person & PersonActivity;

// Changes are made as the admin (spec 2.7: actor user:<uuid>).
const contextOf = (deps: PeoplePageDeps, session: LoadedSession): AuthContext => ({
  at: deps.clock.now(),
  actor: `user:${session.person.id}`,
  userId: session.person.id,
});

const ROLE_LABELS = { admin: "Admin", editor: "Editor" } as const;

// auth.app_user ids. Any other path segment is no person, and the route does not match.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// Spec 8.2 and 8.3: the row menu. Each item submits a small form of its own; Disable comes last,
// behind a confirm dialog.
function RowActions({ person, csrf }: { person: Person; csrf: string }) {
  // Nothing turns a disabled person active again, so the row has no actions.
  if (person.status === "disabled") return null;
  const other = person.role === "admin" ? "editor" : "admin";
  const token = <input type="hidden" name="_csrf" value={csrf} />;
  return (
    <>
      <form id={`role-${person.id}`} method="post" action={`/people/${person.id}/role`}>
        {token}
      </form>
      <form id={`end-${person.id}`} method="post" action={`/people/${person.id}/end-sessions`}>
        {token}
      </form>
      <Menu
        label={`Actions for ${person.email}`}
        align="end"
        items={[
          { label: `Make ${other}`, form: `role-${person.id}`, name: "role", value: other },
          { label: "End sessions", form: `end-${person.id}` },
          "separator",
          { label: "Disable", danger: true, commandfor: `disable-${person.id}`, command: "show-modal" },
        ]}
      />
      <ConfirmDialog
        id={`disable-${person.id}`}
        title={`Disable ${person.email}?`}
        description="They are signed out everywhere and cannot sign in again. Their alerts stop."
        confirmLabel="Disable person"
        action={`/people/${person.id}/disable`}
        fields={token}
      />
    </>
  );
}

// Spec 8.3 /people, admins only.
export function peopleRoutes(deps: PeoplePageDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // The list, with a notice under the header after a refused change.
  const showPeople = async (c: Context<AppEnv>, notice: Child, status: 200 | 403 | 409 | 422) => {
    const csrf = signedIn(c).session.csrfSecret;
    const now = deps.clock.now();
    const [people, activity] = await Promise.all([listPeople(deps.pool), peopleActivity(deps.pool, now)]);
    const rows: PersonRow[] = people.map((person) => ({ ...person, ...(activity.get(person.id) ?? { lastSignInAt: null, devices: 0 }) }));
    return c.html(
      renderPage(c, deps, {
        title: "People",
        active: "people",
        scripts: ["menu", "dialog"],
        children: (
          <>
            <PageHeader
              title="People"
              description="Who can sign in. Adding an address is the approval."
              actions={
                <Button variant="primary" iconStart="plus" commandfor="add-person" command="show-modal">
                  Add person
                </Button>
              }
            />
            {notice}
            <Table<PersonRow>
              caption="People"
              columns={[
                { key: "email", label: "Address", rowHeader: true },
                { key: "role", label: "Role", render: (row) => ROLE_LABELS[row.role] },
                {
                  key: "status",
                  label: "Status",
                  render: (row) => (row.status === "active" ? <Badge tone="success">Active</Badge> : <Badge>Disabled</Badge>),
                },
                { key: "lastSignIn", label: "Last sign-in", render: (row) => (row.lastSignInAt === null ? "Never" : formatWhen(row.lastSignInAt, now)) },
                { key: "devices", label: "Devices", numeric: true, render: (row) => String(row.devices) },
                { key: "menu", label: <span class="ia-sr">Actions</span>, render: (row) => <RowActions person={row} csrf={csrf} /> },
              ]}
              rows={rows}
            />
            <Dialog id="add-person" size="md" title="Add person" description="They can sign in with a code sent to this address.">
              <form method="post" action="/people" class="app-stack">
                <input type="hidden" name="_csrf" value={csrf} />
                <Input id="add-person-email" name="email" type="email" label="Address" autocomplete="off" required />
                <RadioGroup
                  name="role"
                  legend="Role"
                  value="editor"
                  options={[
                    { value: "editor", label: "Editor", description: "Watches and edits products." },
                    { value: "admin", label: "Admin", description: "Also changes settings and people." },
                  ]}
                />
                <div class="app-row">
                  <Button commandfor="add-person" command="close">
                    Cancel
                  </Button>
                  <Button variant="primary" type="submit">
                    Add person
                  </Button>
                </div>
              </form>
            </Dialog>
          </>
        ),
      }),
      status,
    );
  };

  // Spec 7.4 step-up: a change to people needs a sign-in in the last 15 minutes. Signing out
  // leads to the sign-in page, and the new session counts as recent. The page says so before a
  // change, and a change without it is refused.
  const stepUpNeeded = (c: Context<AppEnv>, status: 200 | 403 = 403) =>
    showPeople(
      c,
      <Banner
        tone="warning"
        action={
          <Button type="submit" form="sign-out" variant="secondary" size="sm">
            Sign in again
          </Button>
        }
      >
        Changes to people need a sign-in in the last 15 minutes. Sign in again, then make the change.
      </Banner>,
      status,
    );

  routes.get("/", (c) => (signedInRecently(signedIn(c), deps.clock.now()) ? showPeople(c, null, 200) : stepUpNeeded(c, 200)));

  // Spec 7.7: the last active admin stays an active admin.
  const lastAdmin = async (c: Context<AppEnv>, userId: string) => {
    const email = (await listPeople(deps.pool)).find((person) => person.id === userId)?.email ?? "This person";
    return showPeople(c, <Banner tone="danger">{`${email} is the last active admin. Make someone else an admin first.`}</Banner>, 409);
  };

  routes.post("/", async (c) => {
    const session = signedIn(c);
    if (!signedInRecently(session, deps.clock.now())) return stepUpNeeded(c);
    const body = await c.req.parseBody();
    const email = normalizeAddress(typeof body["email"] === "string" ? body["email"] : "");
    const role = body["role"] === "admin" ? "admin" : "editor";
    if (email === null) return showPeople(c, <Banner tone="danger">Enter one email address, for example anna@example.com.</Banner>, 422);
    const added = await addPerson(deps.pool, { email, role }, contextOf(deps, session));
    if (!added.ok) return showPeople(c, <Banner tone="danger">{`${email} is already on the list.`}</Banner>, 409);
    return c.redirect("/people", 303);
  });

  // A change to one person: back to the list, unless the person is unknown or the last admin.
  const afterChange = (c: Context<AppEnv>, userId: string, result: { ok: true } | { ok: false; reason: "not_found" | "unchanged" | "last_admin" }) => {
    if (!result.ok && result.reason === "not_found") return c.html(errorPage({ status: 404, assets: deps.assets }), 404);
    if (!result.ok && result.reason === "last_admin") return lastAdmin(c, userId);
    return c.redirect("/people", 303);
  };

  routes.post(`/:id{${UUID}}/role`, async (c) => {
    const session = signedIn(c);
    if (!signedInRecently(session, deps.clock.now())) return stepUpNeeded(c);
    const body = await c.req.parseBody();
    const role = body["role"] === "admin" ? "admin" : "editor";
    const userId = c.req.param("id");
    return afterChange(c, userId, await changeRole(deps.pool, { userId, role }, contextOf(deps, session)));
  });

  routes.post(`/:id{${UUID}}/end-sessions`, async (c) => {
    const session = signedIn(c);
    if (!signedInRecently(session, deps.clock.now())) return stepUpNeeded(c);
    const userId = c.req.param("id");
    return afterChange(c, userId, await endPersonSessions(deps.pool, { userId }, contextOf(deps, session)));
  });

  // Spec 7.7: in one transaction the sessions end, the devices are revoked and open codes close.
  routes.post(`/:id{${UUID}}/disable`, async (c) => {
    const session = signedIn(c);
    if (!signedInRecently(session, deps.clock.now())) return stepUpNeeded(c);
    const userId = c.req.param("id");
    return afterChange(c, userId, await disablePerson(deps.pool, { userId }, contextOf(deps, session)));
  });

  return routes;
}
