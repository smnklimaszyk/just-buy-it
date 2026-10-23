// Component cases shared by two sides. tools/sync-design-system renders them with the design
// system's React reference into reference-markup.json; components.test.tsx renders them with
// the port and compares. A case with `deviation` must differ from the reference, for the reason
// given (ADR 0039 lists the deviations); every other case must match it.
// Plain data only, so the tool can read this file with Node's type stripping.

export type CaseValue =
  | string
  | number
  | boolean
  | CaseElement
  | readonly CaseValue[]
  | { readonly [key: string]: CaseValue };

export interface CaseElement {
  readonly $c: string;
  readonly p?: { readonly [key: string]: CaseValue };
  readonly children?: readonly CaseValue[];
}

export interface ReferenceCase {
  readonly id: string;
  readonly node: CaseElement;
  readonly deviation?: string;
}

const button = (label: string, p: { readonly [key: string]: CaseValue } = {}): CaseElement => ({
  $c: "Button",
  p,
  children: [label],
});

export const REFERENCE_CASES: readonly ReferenceCase[] = [
  { id: "Icon/decorative", node: { $c: "Icon", p: { name: "check" } } },
  { id: "Icon/labelled", node: { $c: "Icon", p: { name: "info", size: 20, label: "Information" } } },
  { id: "Spinner/plain", node: { $c: "Spinner", p: { size: 16 } } },
  { id: "Spinner/labelled", node: { $c: "Spinner", p: { label: "Loading" } } },

  { id: "Button/primary-submit", node: button("Save draft", { variant: "primary", type: "submit", name: "intent", value: "save" }) },
  { id: "Button/secondary-icon", node: button("Check cost", { iconStart: "refresh-cw" }) },
  { id: "Button/quiet-small", node: button("Clear", { variant: "quiet", size: "sm" }) },
  { id: "Button/danger", node: button("Archive product", { variant: "danger" }) },
  { id: "Button/large-full", node: button("Send code", { variant: "primary", size: "lg", fullWidth: true, type: "submit" }) },
  { id: "Button/loading-icon", node: button("Check cost", { iconStart: "refresh-cw", loading: true }) },
  { id: "Button/loading-overlay", node: button("Save changes", { variant: "primary", loading: true }) },
  { id: "Button/disabled-icon-end", node: button("Next", { iconEnd: "chevron-right", disabled: true }) },
  { id: "IconButton/small", node: { $c: "IconButton", p: { icon: "x", label: "Close", size: "sm" } } },
  { id: "IconButton/secondary", node: { $c: "IconButton", p: { icon: "ellipsis", label: "More actions", variant: "secondary" } } },
  { id: "Link/internal", node: { $c: "Link", p: { href: "/products" }, children: ["All products"] } },
  { id: "Link/external", node: { $c: "Link", p: { href: "https://www.ebay.de/itm/123456789012", external: true }, children: ["Open on eBay"] } },
  { id: "Link/subtle", node: { $c: "Link", p: { href: "/deals", subtle: true }, children: ["Deals"] } },
  { id: "Separator/plain", node: { $c: "Separator" } },

  { id: "Input/bare", node: { $c: "Input", p: { id: "q", name: "q", placeholder: "Search products", "aria-label": "Search products" } } },
  {
    id: "Input/label-hint",
    node: { $c: "Input", p: { id: "name", name: "name", label: "Name", hint: "Shown in alerts and lists.", value: "Road bike 56 cm" } },
  },
  { id: "Input/error", node: { $c: "Input", p: { id: "max", name: "max", label: "Max price", error: "Enter a price in euros, for example 450.", value: "abc" } } },
  { id: "Input/large-optional", node: { $c: "Input", p: { id: "email", name: "email", type: "email", label: "Email address", size: "lg", optional: true } } },
  { id: "Input/icon-trailing", node: { $c: "Input", p: { id: "floor", name: "floor", label: "Floor", iconStart: "tag", trailing: "EUR" } } },
  {
    id: "Textarea/counter",
    node: {
      $c: "Textarea",
      p: { id: "description", name: "description", label: "Description for the Claude check", hint: "Say what it is and what it is not.", maxLength: 300, value: "Used road bike" },
    },
  },
  { id: "Textarea/error", node: { $c: "Textarea", p: { id: "must", name: "must", label: "Must contain", rows: 4, error: "Add at least one line.", value: "" } } },
  {
    id: "Select/value",
    node: {
      $c: "Select",
      p: {
        id: "status",
        name: "status",
        label: "Status",
        value: "active",
        options: [
          { value: "active", label: "Active" },
          { value: "paused", label: "Paused" },
          { value: "archived", label: "Archived", disabled: true },
        ],
      },
    },
  },
  {
    id: "Select/placeholder-groups",
    node: {
      $c: "Select",
      p: {
        id: "category",
        name: "category",
        label: "eBay category",
        placeholder: "Choose a category",
        hint: "Categories already in use come first.",
        options: [
          { label: "In use", options: [{ value: "3323", label: "Lenses" }] },
          { label: "Other", options: [{ value: "177", label: "Road bikes" }] },
        ],
      },
    },
  },
  {
    id: "RadioGroup/list",
    node: {
      $c: "RadioGroup",
      p: {
        legend: "Speed",
        name: "speed",
        value: "normal",
        options: [
          { value: "slow", label: "Slow" },
          { value: "normal", label: "Normal" },
          { value: "fast", label: "Fast", disabled: true },
        ],
      },
    },
  },
  {
    id: "RadioGroup/cards",
    node: {
      $c: "RadioGroup",
      p: {
        legend: "Price rule",
        name: "price_rule",
        variant: "cards",
        value: "fixed",
        options: [
          { value: "fixed", label: "Fixed max price", description: "Alert below a price you set." },
          { value: "market", label: "Below the typical asking price", description: "Alert a set percent below the market value." },
        ],
      },
    },
  },
  {
    id: "RadioGroup/horizontal",
    node: { $c: "RadioGroup", p: { name: "theme", orientation: "horizontal", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }] } },
  },
  { id: "Checkbox/checked", node: { $c: "Checkbox", p: { id: "c-used", name: "conditions", value: "used", checked: true, label: "Used", description: "Seller says used." } } },
  {
    id: "Checkbox/unchecked",
    node: { $c: "Checkbox", p: { id: "c-new", name: "conditions", value: "new", label: "New" } },
    deviation: "The port always renders the check glyph and app.css shows it for :checked, so a click works without script.",
  },
  { id: "Checkbox/disabled", node: { $c: "Checkbox", p: { id: "c-alert", name: "alert_to", value: "info", checked: true, disabled: true, label: "info@intra-ai.de" } } },
  { id: "TagsInput/empty", node: { $c: "TagsInput", p: { id: "exclude", label: "Must not contain", hint: "word* matches the start, ~word a near match." } } },
  {
    id: "TagsInput/values",
    node: { $c: "TagsInput", p: { id: "search", label: "Search words", value: ["canon 85mm", "founders"] } },
    deviation: "Without script the field is one text input with the words separated by commas; tags.ts turns it into chips.",
  },
  { id: "OtpInput/eight", node: { $c: "OtpInput", p: { length: 8, value: "1234", label: "Sign-in code", name: "code" } } },
  {
    id: "Fieldset/plain",
    node: {
      $c: "Fieldset",
      p: { legend: "Matching", description: "Words are checked on every new listing." },
      children: [{ $c: "Input", p: { id: "fs-name", name: "fs-name", label: "Name" } }],
    },
  },

  {
    id: "AppShell/full",
    node: {
      $c: "AppShell",
      p: {
        sidebar: {
          $c: "Sidebar",
          p: {
            footer: { $c: "SidebarItem", p: { icon: "user", label: "Account", href: "/account" } },
          },
          children: [
            {
              $c: "SidebarSection",
              p: { label: "Watch" },
              children: [
                { $c: "SidebarItem", p: { icon: "home", label: "Overview", href: "/", active: true } },
                { $c: "SidebarItem", p: { icon: "layers", label: "Products", href: "/products", trailing: "6" } },
              ],
            },
          ],
        },
        header: { $c: "AppHeader", p: { end: button("Sign out", { variant: "quiet", size: "sm" }) } },
      },
      children: ["Page content"],
    },
  },
  {
    id: "SidebarBrand/wordmark",
    node: { $c: "SidebarBrand", p: { name: "Just-Buy-It", href: "/" } },
    deviation: "Wordmark only: the IntraMark logo stays out of the public repo (owner decision 1).",
  },
  {
    id: "PageHeader/full",
    node: {
      $c: "PageHeader",
      p: {
        title: "Products",
        description: "What the platform watches on eBay and when it sends an alert.",
        actions: button("Add product", { variant: "primary", iconStart: "plus" }),
      },
    },
  },
  { id: "PageHeader/title-only", node: { $c: "PageHeader", p: { title: "Budget" } } },
  {
    id: "Breadcrumbs/two",
    node: { $c: "Breadcrumbs", p: { items: [{ label: "Products", href: "/products" }, { label: "Road bike 56 cm" }] } },
  },
  {
    id: "Tabs/links",
    node: {
      $c: "Tabs",
      p: {
        label: "Product",
        idPrefix: "product",
        value: "overview",
        tabs: [
          { value: "overview", label: "Overview", href: "/products/bike" },
          { value: "deals", label: "Deals", count: 3, href: "/products/bike/deals" },
        ],
      },
    },
    deviation: "Each tab is its own page, so tabs are links in a nav with aria-current instead of role=tab buttons.",
  },
  {
    id: "Menu/open",
    node: {
      $c: "Menu",
      p: {
        label: "Actions for Road bike",
        defaultOpen: true,
        align: "end",
        items: [
          { label: "Edit", icon: "pencil", href: "/products/bike/edit" },
          "separator",
          { label: "Archive", icon: "archive", danger: true, href: "/products/bike?confirm=archive" },
        ],
      },
    },
    deviation: "A native <details> menu with links, so row actions work without script; menu.ts adds Escape and arrow keys.",
  },
  {
    id: "Pagination/middle",
    node: { $c: "Pagination", p: { page: 3, pageCount: 9, total: 420, pageSize: 50, href: "/deals?page=" } },
    deviation: "Pages are links (?page=n) instead of buttons, so paging works without script.",
  },

  { id: "Badge/neutral", node: { $c: "Badge", children: ["Paused"] } },
  { id: "Badge/success", node: { $c: "Badge", p: { tone: "success" }, children: ["Active"] } },
  { id: "Badge/info-no-icon", node: { $c: "Badge", p: { tone: "info", icon: false }, children: ["Draft"] } },
  { id: "Badge/warning-own-icon", node: { $c: "Badge", p: { tone: "warning", icon: "clock" }, children: ["Held"] } },
  { id: "Badge/danger", node: { $c: "Badge", p: { tone: "danger" }, children: ["Blocked"] } },
  { id: "StatusDot/success", node: { $c: "StatusDot", p: { tone: "success", label: "Worker running" } } },
  { id: "StatusDot/pulse", node: { $c: "StatusDot", p: { tone: "info", label: "Checking", pulse: true } } },
  {
    id: "Banner/warning-action",
    node: {
      $c: "Banner",
      p: { tone: "warning", title: "Claude checks paused.", action: button("Open settings", { size: "sm" }) },
      children: ["The daily spend cap is reached until 00:00."],
    },
  },
  { id: "Banner/info", node: { $c: "Banner", children: ["Market values update every night between 03:00 and 05:00."] } },
  { id: "Callout/info", node: { $c: "Callout", p: { title: "Cost" }, children: ["This product plans 204 eBay calls a day."] } },
  { id: "Callout/danger", node: { $c: "Callout", p: { tone: "danger" }, children: ["The plan would reach 2,541 calls a day, over the 2,500 limit."] } },
  { id: "Toast/success", node: { $c: "Toast", p: { tone: "success", title: "Product saved", description: "Polling starts within a minute." } } },
  { id: "Toast/neutral", node: { $c: "Toast", p: { title: "Signed out everywhere" } } },
  {
    id: "Meter/warning",
    node: { $c: "Meter", p: { value: 2100, max: 2500, label: "eBay calls planned", caption: "Saving more products may be refused." } },
    deviation: "The fill is an SVG rect width instead of an inline transform, because the CSP has no inline styles.",
  },
  { id: "EmptyState/action", node: { $c: "EmptyState", p: { icon: "layers", title: "No products yet", description: "Products you add appear here.", action: button("Add product", { variant: "primary" }) } } },
  { id: "EmptyState/start", node: { $c: "EmptyState", p: { title: "No deals in the last 24 hours", align: "start" } } },
  {
    id: "ErrorState/secondary",
    node: { $c: "ErrorState", p: { title: "The page could not load", description: "Nothing was changed.", secondary: { $c: "Link", p: { href: "/" }, children: ["Back to overview"] } } },
  },
  {
    id: "Table/rows",
    node: {
      $c: "Table",
      p: {
        caption: "Searches",
        columns: [
          { key: "id", label: "Search", mono: true, rowHeader: true },
          { key: "q", label: "Words" },
          { key: "calls", label: "Calls a day", numeric: true },
        ],
        rows: [
          { id: "s-1", q: "canon 85mm", calls: "204" },
          { id: "s-2", q: "road bike 56", calls: "96" },
        ],
      },
    },
  },
  {
    id: "Table/empty",
    node: { $c: "Table", p: { caption: "Deals", columns: [{ key: "product", label: "Product" }], rows: [], empty: "Deals appear here when a listing passes your limit." } },
  },
  {
    id: "DescriptionList/row",
    node: { $c: "DescriptionList", p: { items: [{ label: "Typical asking price", value: "EUR 1,234", numeric: true }, { label: "Item", value: "123456789012", mono: true }] } },
  },
  { id: "DescriptionList/stack", node: { $c: "DescriptionList", p: { layout: "stack", items: [{ label: "Listings counted", value: "41" }] } } },
  { id: "StatTile/delta", node: { $c: "StatTile", p: { label: "Deals today", value: "3", delta: "+2", deltaLabel: "since yesterday", trend: "up-good" } } },
  { id: "StatTile/unit-caption", node: { $c: "StatTile", p: { label: "Claude spend", value: "1.84", unit: "USD", caption: "Cap USD 5.00 a day" } } },
  {
    id: "Dialog/form",
    node: {
      $c: "Dialog",
      p: {
        id: "add-person",
        title: "Add person",
        description: "They get a sign-in code by email.",
        size: "md",
        actions: button("Add person", { variant: "primary", type: "submit", form: "add-person-form" }),
      },
      children: [{ $c: "Input", p: { id: "person-email", name: "email", type: "email", label: "Email address" } }],
    },
    deviation: "A native <dialog> opened with showModal() (command=show-modal), not a React overlay root (ADR 0039).",
  },
  {
    id: "ConfirmDialog/danger",
    node: {
      $c: "ConfirmDialog",
      p: { id: "archive", action: "/products/bike/archive", title: "Archive this product?", description: "It stops polling. Its deals stay.", confirmLabel: "Archive product" },
    },
    deviation: "A native <dialog> whose confirm button posts the form and whose Cancel closes it (command=close).",
  },
  {
    id: "Surface/full",
    node: { $c: "Surface", p: { title: "Market value", description: "Used, last 30 days", footer: button("Check market value", { size: "sm" }) }, children: ["EUR 1,234"] },
  },
];
