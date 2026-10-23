import { describe, expect, it } from "vitest";
import {
  AppHeader,
  AppShell,
  Button,
  ButtonLink,
  DrawerToggle,
  ErrorState,
  Menu,
  SidebarItem,
  ThemeToggle,
  Toast,
  ToastRegion,
} from "./index.js";
import { diffMarkup } from "./testing/markup.js";

// Components the reference does not have, or server-side variants of one.
describe("ButtonLink", () => {
  it("is a link with exactly the markup of the matching Button inside", () => {
    const link = String(
      <ButtonLink href="/products/new" variant="primary" iconStart="plus">
        Add product
      </ButtonLink>,
    );
    const button = String(
      <Button variant="primary" iconStart="plus">
        Add product
      </Button>,
    );

    expect(link.startsWith(`<a href="/products/new" class="ia-btn type-ui-strong ia-btn--primary ia-btn--md">`)).toBe(true);
    expect(diffMarkup(link.replace(/^<a href="[^"]*"/, "<button").replace(/<\/a>$/, "</button>"), button.replace(` type="button"`, ""))).toEqual([]);
  });
});

describe("AppShell drawer", () => {
  it("gives the sidebar an id that the menu link opens by :target, with a scrim link that closes it", () => {
    const html = String(
      <AppShell drawerId="sidebar" sidebar="Nav" header={<AppHeader start={<DrawerToggle drawerId="sidebar" />} />}>
        Content
      </AppShell>,
    );

    expect(html).toContain(`<a class="ia-shell__scrim" href="#main" aria-label="Close menu" tabindex="-1"></a>`);
    expect(html).toContain(`<aside class="ia-shell__sidebar" aria-label="Sidebar" id="sidebar">Nav</aside>`);
    expect(html).toContain(`<a href="#sidebar" aria-label="Open menu" title="Open menu" class="ia-iconbtn ia-iconbtn--quiet ia-iconbtn--sm app-drawer-toggle">`);
  });
});

describe("Menu items", () => {
  it("post a form on the page or open a dialog, besides plain links", () => {
    const html = String(
      <Menu
        items={[
          { label: "Pause", icon: "pause", form: "row-bike", name: "intent", value: "pause" },
          { label: "Archive", icon: "archive", danger: true, commandfor: "archive-bike", command: "show-modal" },
        ]}
      />,
    );

    expect(html).toContain(`<button type="submit" form="row-bike" name="intent" value="pause" class="ia-menu__item type-ui-body">`);
    expect(html).toContain(`<button type="button" commandfor="archive-bike" command="show-modal" class="ia-menu__item type-ui-body is-danger">`);
  });
});

describe("server-side actions", () => {
  it("ErrorState retries with a primary link and SidebarItem can submit a form (Sign out)", () => {
    const error = String(<ErrorState title="The page could not load" retryHref="/products" />);
    const signOut = String(<SidebarItem icon="log-out" label="Sign out" type="submit" form="sign-out" />);

    expect(error).toContain(`<a href="/products" class="ia-btn type-ui-strong ia-btn--primary ia-btn--md">`);
    expect(error).toContain(`Try again</span></a>`);
    expect(signOut).toMatch(/^<div class="ia-side-row"><button type="submit" form="sign-out" class="ia-side type-ui-body">/);
  });
});

describe("ThemeToggle", () => {
  it("posts the other theme with the CSRF token and the page to return to, and carries both labels for theme.ts", () => {
    const html = String(<ThemeToggle theme="light" csrfToken="tok-1" back="/products?status=active" />);

    expect(html).toMatch(/^<form method="post" action="\/theme" data-theme-toggle="">/);
    expect(html).toContain(`<input type="hidden" name="_csrf" value="tok-1"/>`);
    expect(html).toContain(`<input type="hidden" name="theme" value="dark"/>`);
    expect(html).toContain(`<input type="hidden" name="back" value="/products?status=active"/>`);
    expect(html).toContain(`<span class="app-when-light">Dark theme</span><span class="app-when-dark">Light theme</span>`);
    expect(String(<ThemeToggle theme="dark" csrfToken="tok-1" back="/" />)).toContain(`name="theme" value="light"`);
  });
});

describe("ToastRegion", () => {
  it("is a labelled region that holds the toasts", () => {
    const html = String(
      <ToastRegion>
        <Toast tone="success" title="Product saved" />
      </ToastRegion>,
    );

    expect(html).toMatch(/^<section class="app-toasts" aria-label="Notifications"><div class="ia-toast ia-toast--success" role="status">/);
  });
});
