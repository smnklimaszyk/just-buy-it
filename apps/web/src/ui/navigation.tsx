// Navigation: AppShell, AppHeader, Sidebar and its parts, PageHeader, Breadcrumbs, Tabs, Menu,
// Pagination. Same markup as the design system's navigation.tsx, except where a page has to work
// without script: tabs and pages are links, the menu is a <details>, the drawer opens by :target.
import { IconButton, Icon } from "./core.js";
import type { IconName } from "./icon-names.js";
import { cx, T, type Child } from "./shared.js";

export interface AppShellProps {
  sidebar: Child;
  header?: Child;
  children?: Child;
  /**
   * Id for the sidebar, so a link to `#<id>` opens it as a drawer below 768 px without script.
   * The page header then needs a menu link to it (DrawerToggle).
   */
  drawerId?: string;
}

export function AppShell({ sidebar, header, children, drawerId }: AppShellProps) {
  return (
    <div class="ia-shell">
      {drawerId && <a class="ia-shell__scrim" href="#main" aria-label="Close menu" tabindex={-1} />}
      <aside class="ia-shell__sidebar" aria-label="Sidebar" id={drawerId}>
        {sidebar}
      </aside>
      <div class="ia-shell__main">
        {header}
        <main class="ia-shell__content" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}

/** The menu button that opens the sidebar drawer on phones; app.css hides it from 768 px. */
export function DrawerToggle({ drawerId }: { drawerId: string }) {
  return <IconButton href={`#${drawerId}`} icon="menu" label="Open menu" size="sm" className="app-drawer-toggle" />;
}

export interface AppHeaderProps {
  title?: Child;
  start?: Child;
  center?: Child;
  end?: Child;
}

export function AppHeader({ start, center, end, title }: AppHeaderProps) {
  return (
    <header class="ia-appheader">
      <div class="ia-appheader__start">
        {start}
        {title && <h1 class={cx("ia-appheader__title", T.strong)}>{title}</h1>}
      </div>
      <div class="ia-appheader__center">{center}</div>
      <div class="ia-appheader__end">{end}</div>
    </header>
  );
}

export interface SidebarProps {
  header?: Child;
  footer?: Child;
  children?: Child;
}

export function Sidebar({ header, children, footer }: SidebarProps) {
  return (
    <div class="ia-sidebar">
      {header && <div class="ia-sidebar__head">{header}</div>}
      <nav class="ia-sidebar__body" aria-label="Main">
        {children}
      </nav>
      {footer && <div class="ia-sidebar__foot">{footer}</div>}
    </div>
  );
}

export interface SidebarBrandProps {
  name: string;
  href?: string;
  actions?: Child;
}

/** Wordmark only: the IntraMark logo stays out of the public repo (owner decision 1). */
export function SidebarBrand({ name, href = "/", actions }: SidebarBrandProps) {
  return (
    <div class="ia-side-brand">
      <a class={cx("ia-side-brand__link", T.strong)} href={href}>
        <span class={T.titleSm}>{name}</span>
      </a>
      <span class="ia-side-brand__actions">{actions}</span>
    </div>
  );
}

export interface SidebarSectionProps {
  label?: string;
  /** Id of the section heading; taken from the label when left out. */
  id?: string;
  action?: Child;
  children?: Child;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function SidebarSection({ label, id, children, action }: SidebarSectionProps) {
  const headingId = label ? (id ?? `side-${slug(label)}`) : undefined;
  return (
    <section class="ia-side-section" aria-labelledby={headingId}>
      {label && (
        <div class="ia-side-section__head">
          <h3 id={headingId} class={cx("ia-side-section__label", T.caption)}>
            {label}
          </h3>
          {action}
        </div>
      )}
      <div class="ia-side-section__list">{children}</div>
    </section>
  );
}

export interface SidebarItemProps {
  label: Child;
  icon?: IconName;
  active?: boolean;
  trailing?: Child;
  /** A link, or else a button: give `type: "submit"` and `form` to post a form (Sign out). */
  href?: string;
  type?: "button" | "submit";
  form?: string;
  actions?: Child;
}

export function SidebarItem({ icon, label, active = false, trailing, href, type = "button", form, actions }: SidebarItemProps) {
  const cls = cx("ia-side", T.body, active && "is-on");
  const content = [
    icon && <Icon name={icon} size={16} className="ia-side__icon" />,
    <span class="ia-side__label">{label}</span>,
    trailing != null && <span class={cx("ia-side__trail", T.caption)}>{trailing}</span>,
  ];
  return (
    <div class={cx("ia-side-row", active && "is-on")}>
      {href !== undefined ? (
        <a href={href} aria-current={active ? "page" : undefined} class={cls}>
          {content}
        </a>
      ) : (
        <button type={type} form={form} aria-current={active ? "page" : undefined} class={cls}>
          {content}
        </button>
      )}
      {actions && <span class="ia-side__actions">{actions}</span>}
    </div>
  );
}

export interface PageHeaderProps {
  title: Child;
  description?: Child;
  breadcrumbs?: Child;
  actions?: Child;
  tabs?: Child;
}

export function PageHeader({ title, description, breadcrumbs, actions, tabs }: PageHeaderProps) {
  return (
    <header class="ia-pagehead">
      {breadcrumbs}
      <div class="ia-pagehead__row">
        <div class="ia-pagehead__text">
          <h1 class={cx("ia-pagehead__title", T.titleLg)}>{title}</h1>
          {description && <p class={cx("ia-pagehead__desc", T.body)}>{description}</p>}
        </div>
        {actions && <div class="ia-pagehead__actions">{actions}</div>}
      </div>
      {tabs && <div class="ia-pagehead__tabs">{tabs}</div>}
    </header>
  );
}

export interface BreadcrumbsProps {
  items: { label: Child; href?: string }[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" class="ia-crumbs">
      <ol>
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li class={T.bodySm}>
              {last ? <span aria-current="page">{it.label}</span> : <a href={it.href}>{it.label}</a>}
              {!last && <Icon name="chevron-right" size={14} className="ia-crumbs__sep" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface TabsProps {
  /** Names the navigation. */
  label: string;
  value: string;
  tabs: { value: string; label: Child; href: string; count?: number }[];
}

/** Each tab is its own page: links in a nav, the current one with aria-current. */
export function Tabs({ tabs, value, label }: TabsProps) {
  return (
    <nav class="ia-tabs" aria-label={label}>
      {tabs.map((t) => (
        <a href={t.href} aria-current={t.value === value ? "page" : undefined} class={cx("ia-tab", T.strong, t.value === value && "is-on")}>
          {t.label}
          {t.count != null && <span class={cx("ia-tab__count", T.caption)}>{t.count}</span>}
        </a>
      ))}
    </nav>
  );
}

interface MenuItemBase {
  label: Child;
  description?: Child;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
}
/** A link, a submit button for a form on the page, or a button that opens a dialog. */
export type MenuItem =
  | (MenuItemBase & { href: string })
  | (MenuItemBase & { form: string; name?: string; value?: string })
  | (MenuItemBase & { commandfor: string; command: "show-modal" })
  | { group: Child }
  | "separator";

export interface MenuProps {
  items: MenuItem[];
  label?: string;
  align?: "start" | "end";
  defaultOpen?: boolean;
}

/**
 * A native <details>: the summary opens it without script, the items are links or buttons.
 * menu.ts adds the menu roles, arrow keys, Escape and closing on an outside click.
 */
export function Menu({ items, label = "More actions", align = "start", defaultOpen = false }: MenuProps) {
  return (
    <details class="ia-menu-wrap" data-menu="" open={defaultOpen}>
      <summary aria-label={label} title={label} class="ia-iconbtn ia-iconbtn--quiet ia-iconbtn--md">
        <Icon name="ellipsis" size={18} />
      </summary>
      <div class={cx("ia-menu", align === "end" && "ia-menu--end")} aria-label={label}>
        {items.map((it) => {
          if (it === "separator") return <div class="ia-menu__sep" role="separator" />;
          if ("group" in it) return <div class={cx("ia-menu__group", T.caption)}>{it.group}</div>;
          const cls = cx("ia-menu__item", T.body, it.danger && "is-danger");
          const content = [
            it.icon && <Icon name={it.icon} size={16} />,
            <span class="ia-menu__label">
              {it.label}
              {it.description && <span class={cx("ia-menu__desc", T.bodySm)}>{it.description}</span>}
            </span>,
          ];
          if ("href" in it) {
            return (
              <a href={it.href} class={cls} aria-disabled={it.disabled ? "true" : undefined}>
                {content}
              </a>
            );
          }
          if ("form" in it) {
            return (
              <button type="submit" form={it.form} name={it.name} value={it.value} disabled={it.disabled} class={cls}>
                {content}
              </button>
            );
          }
          return (
            <button type="button" commandfor={it.commandfor} command={it.command} disabled={it.disabled} class={cls}>
              {content}
            </button>
          );
        })}
      </div>
    </details>
  );
}

function pageList(page: number, count: number): (number | "gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const sorted = [...new Set([1, count, page - 1, page, page + 1].filter((n) => n >= 1 && n <= count))].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && n - prev > 1) out.push("gap");
    out.push(n);
  });
  return out;
}

export interface PaginationProps {
  page: number;
  pageCount: number;
  /** Link prefix; the page number is appended, for example "/deals?page=". */
  href: string;
  total?: number;
  pageSize?: number;
}

export function Pagination({ page, pageCount, href, total, pageSize = 50 }: PaginationProps) {
  const from = total ? (page - 1) * pageSize + 1 : null;
  const to = total ? Math.min(page * pageSize, total) : null;
  return (
    <nav class="ia-pager" aria-label="Pagination">
      {total ? (
        <p class={cx("ia-pager__summary", T.bodySm, "ia-num")}>
          {from}–{to} of {total}
        </p>
      ) : (
        <span />
      )}
      <div class="ia-pager__pages">
        {page <= 1 ? (
          <IconButton icon="chevron-left" label="Previous page" size="sm" disabled />
        ) : (
          <IconButton icon="chevron-left" label="Previous page" size="sm" href={`${href}${page - 1}`} />
        )}
        {pageList(page, pageCount).map((n) =>
          n === "gap" ? (
            <span class={cx("ia-pager__gap", T.bodySm)} aria-hidden="true">
              …
            </span>
          ) : (
            <a
              href={`${href}${n}`}
              class={cx("ia-pager__num", T.label, "ia-num", n === page && "is-on")}
              aria-current={n === page ? "page" : undefined}
              aria-label={`Page ${n}`}
            >
              {n}
            </a>
          ),
        )}
        {page >= pageCount ? (
          <IconButton icon="chevron-right" label="Next page" size="sm" disabled />
        ) : (
          <IconButton icon="chevron-right" label="Next page" size="sm" href={`${href}${page + 1}`} />
        )}
      </div>
    </nav>
  );
}
