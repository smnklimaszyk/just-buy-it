import type { Context } from "hono";
import { themeCookie } from "./auth/cookies.js";
import type { AppEnv } from "./session.js";
import type { AssetManifest, ClientScript } from "./ui/assets.js";
import { renderDocument, ThemeToggle, type DocumentProps } from "./ui/document.js";
import type { IconName } from "./ui/icon-names.js";
import { AppHeader, AppShell, DrawerToggle, Sidebar, SidebarBrand, SidebarItem, SidebarSection } from "./ui/navigation.js";
import type { Child } from "./ui/shared.js";

// Spec 8.2: the frame of every signed-in page. Sidebar "Watch" and "Platform", People and
// Activity for admins only, and at the bottom Account, the theme toggle and Sign out.

export type NavItem = "overview" | "deals" | "products" | "budget" | "settings" | "people" | "activity" | "account";

type Entry = { id: NavItem; label: string; href: string; icon: IconName; adminOnly?: boolean };

const WATCH: Entry[] = [
  { id: "overview", label: "Overview", href: "/", icon: "home" },
  { id: "deals", label: "Deals", href: "/deals", icon: "tag" },
  { id: "products", label: "Products", href: "/products", icon: "layers" },
];

const PLATFORM: Entry[] = [
  { id: "budget", label: "Budget", href: "/budget", icon: "gauge" },
  { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
  { id: "people", label: "People", href: "/people", icon: "users", adminOnly: true },
  { id: "activity", label: "Activity", href: "/activity", icon: "activity", adminOnly: true },
];

export type PageInput = {
  title: string;
  active: NavItem;
  children: Child;
  scripts?: ClientScript[];
  refresh?: DocumentProps["refresh"];
};

// The whole signed-in page as HTML. Only for routes behind the session guard.
export function renderPage(c: Context<AppEnv>, deps: { assets: AssetManifest }, page: PageInput): string {
  const session = c.get("session");
  if (session === null) throw new Error("renderPage needs a session");
  const isAdmin = session.person.role === "admin";
  const csrf = session.session.csrfSecret;
  const theme = themeCookie(c);
  const item = (entry: Entry) =>
    entry.adminOnly === true && !isAdmin ? null : (
      <SidebarItem icon={entry.icon} label={entry.label} href={entry.href} active={entry.id === page.active} />
    );
  const sidebar = (
    <Sidebar
      header={<SidebarBrand name="Just-Buy-It" />}
      footer={[
        <SidebarItem icon="user" label="Account" href="/account" active={page.active === "account"} />,
        <ThemeToggle theme={theme} csrfToken={csrf} back={c.req.path} />,
        <form method="post" action="/logout" id="sign-out">
          <input type="hidden" name="_csrf" value={csrf} />
        </form>,
        <SidebarItem icon="log-out" label="Sign out" type="submit" form="sign-out" />,
      ]}
    >
      <SidebarSection label="Watch">{WATCH.map(item)}</SidebarSection>
      <SidebarSection label="Platform">{PLATFORM.map(item)}</SidebarSection>
    </Sidebar>
  );
  return renderDocument({
    title: page.title,
    theme,
    assets: deps.assets,
    ...(page.scripts === undefined ? {} : { scripts: page.scripts }),
    ...(page.refresh === undefined ? {} : { refresh: page.refresh }),
    children: (
      <AppShell drawerId="sidebar" sidebar={sidebar} header={<AppHeader start={<DrawerToggle drawerId="sidebar" />} />}>
        <div class="app-page">{page.children}</div>
      </AppShell>
    ),
  });
}
