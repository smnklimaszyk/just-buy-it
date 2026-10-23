# ADR-0039: Admin UI with Hono JSX and the Intra AI design system

**Date**: 2026-10-22
**Status**: proposed
**Deciders**: Simon Klimaszyk (D-01)
**Related**: amends ADR 0005, 0006, 0007, 0023; ADR 0011, 0012, 0029, 0037, 0038, 0040; D-37

## Context

- v2 needs an admin UI for products, settings, people and budget (ADR 0037, 0038) for 1 to 10 approved people. The MVP dashboard is a string-template page (`apps/server/src/dashboard-html.ts`) on `127.0.0.1:3142`, every value escaped by hand, tested with `app.request()`.
- ADR 0005 pins React 19.3.x and Vite 8.3.x, ADR 0006 plans a React and Vite `web` package, ADR 0007 has the server serve an SPA. None of it was built.
- The Intra AI design system (local mirror, read 2026-10-22; notes `design-system.md`) has tokens and plain CSS components (`.ia-*` classes in `components/bundle.css`), a typed `components/index.d.ts`, a React reference implementation, a Tailwind 3 preset, Geist fonts under the OFL, a brand book and a logo. The folder has no licence file; only the fonts state one. This repository is public (MIT).
- Hono 4.13.13 (pinned) ships `hono/jsx` server rendering with auto-escaping, `serve-static`, `secure-headers` and `csrf`.
- Owner decisions for the v2 spec, section 12 (2026-10-22): 1 commit only `tokens.css`, `bundle.css`, `index.d.ts`, the fonts with their OFL notice and the icon paths used; no brand book, logo or component sources. 11 UI in English.

## Decision

We build the admin UI as server-rendered Hono JSX in a new app `apps/web`, styled only with the design system's plain CSS and a small layout file that uses token variables, with one small page script per behaviour and every page working without scripts. No React, no Vite build for the UI, no Tailwind, no new runtime dependency.

### Stack

- `apps/web/tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`. `apps/web/src/ui/`: typed ports of the components we use, same `.ia-*` markup as the reference, props typed from `design-system/components/index.d.ts`.
- CSS: `tokens.css`, `components/bundle.css`, `apps/web/src/assets/app.css` (layout, token variables only), served under content-hashed names with `Cache-Control: public, max-age=31536000, immutable`.
- Page scripts in `apps/web/src/client/` (`otp.ts`, `tags.ts`, `dialog.ts`, `form-busy.ts`, `theme.ts`, `market-poll.ts`, `cost-preview.ts`), hashed into `dist/assets`, loaded under `script-src 'self'`. Forms post `application/x-www-form-urlencoded`.
- English UI, `lang="en"`, dates relative under 7 days then "12 Sep 2026", prices `EUR 1,234` with `tabular-nums` (owner decision 11). Theme light by default; the toggle sets `__Host-jbi_theme`.

### Design system files in the repo

- `tools/sync-design-system` copies into `apps/web/design-system/` only: `tokens.css`, `components/bundle.css`, `components/index.d.ts`, the Geist and Geist Mono woff2 files with their OFL notice, and the icon paths the pages use (owner decision 1). No brand book, no IntraMark or other logo, no component sources, no Tailwind preset.
- The sidebar shows the word "Just-Buy-It" in Geist 600 instead of the logo.

### Deviations from the design system

| System | Here | Why |
|---|---|---|
| 6-cell OTP input | 8 cells, gap after the 4th | 8-digit codes (ADR 0038) |
| Product form in a large Sheet | Full page form | Long form, works without script |
| Meter fill as inline style | Fill as an SVG attribute | CSP has no `style-src 'unsafe-inline'` |
| Radix Dialog and focus trap | Native `<dialog>` with `showModal()` | No React; focus trap and Escape for free |
| Wordmark with IntraMark | Wordmark only | Logo stays out of the public repo |
| Radix DropdownMenu | `<details>` menu with `menu.ts` for keys | No React; works without script |
| Accordion with a button and `.is-open` | Native `<details class="ia-acc">` with `summary.ia-acc__trigger`, the chevron turned by `[open]`, the marker hidden | No React; opens without script |
| Tabs and Pagination as buttons | Links | Each tab and page has its own URL |
| TagsInput posting one value per tag | One comma-separated field | One form field, parsed on the server |
| Checkbox glyph rendered when checked | Always rendered, hidden by CSS | Same markup in every state |
| OTP cells at fixed width | Cells shrink below 400 px (32 px wide at 320 px) | 8 cells fit a 320 px screen |
| No equivalent | ButtonLink, ToastRegion, DrawerToggle, ThemeToggle, renderDocument | Pieces only this port needs |

### Amendments

- **ADR 0005**: the React and Vite pin lines no longer cover a UI; `hono/jsx` comes with the pinned Hono 4.13.x. The `web` service needs no new dependency.
- **ADR 0006**: `apps/web` is a new app. It imports `packages/domain`, the main entry of `packages/db` and `packages/notify` (sign-in and security mail only). It does not import `packages/ebay`, `@ebay-sniper/db/queue` or the Claude adapter; from `packages/llm` it imports only `@ebay-sniper/llm/catalog` (models, prices, eval results and the prompt version) for the Settings page: market checks and category suggestions go through request rows that the worker turns into jobs.
- **ADR 0007**: three processes: `server` (deletion endpoint, `/healthz`, `/privacy`), `worker` (all eBay and Claude calls, alert mail) and `web` (UI). `web`'s only outbound call is SMTP for sign-in and security mail. It never calls eBay or Anthropic and never touches `pgboss`.
- **ADR 0023**: UI tests are `app.request()` HTML tests per page and state, one snapshot per component in light and dark, guard tests, and one Playwright run of the main flows (sign in, add a product with cost and market preview, add a person with step-up) in CI against a local stack with fake SMTP.

### Output safety and craft rules

- JSX escapes all text. Charts and meters are SVG built with JSX. Listing links are built only as `https://www.ebay.de/itm/<legacy item id>`, never from `itemWebUrl` or an email.
- One primary button per page; status shown with a word, never by colour alone; real `<table>` with caption and `scope`; layout works at 320 px; `:focus-visible` ring kept; `prefers-reduced-motion` handled by `bundle.css`.

## Alternatives considered

- **Vite React SPA with the Tailwind preset** (ADR 0006 plan): close to the reference components, but about 60 KB of React before app code, client-side state and loading states on every page, a Tailwind 3 versus 4 decision and new pins under the 7-day rule. Worth it only if a screen needs live client state a form post cannot give.
- **Hono JSX with `hono/jsx/dom` islands**: same JSX on both sides, but less used and documented, and few screens are interactive.
- **Keep the string-template dashboard**: no new code, but hand escaping does not scale to forms, and it would not follow the design system.
- **Commit the whole design system** (`scripts/sync.sh` default): simplest sync, but publishes the brand book, logo and component sources without a licence (owner decision 1).

## Consequences

**Positive**
- The strict CSP without inline script or style holds on every page.
- Sessions stay server side; the HTML test pattern of the MVP carries over.
- No new runtime dependency; the design system's CSS classes map one to one onto JSX.

**Negative**
- Components are ported by hand from the React reference and drift when the system changes; `tools/sync-design-system` and the snapshots show the drift, a person fixes it.
- Interactive pieces (tags input, OTP, dialogs, market polling) need our own small scripts.
- The design system has no licence file, so even the files we commit rest on the owner's decision.

**Risks**
- An escape hatch (`raw(`, `dangerouslySetInnerHTML`, `` html` ``) brings back injection. Mitigation: guard test.
- A token or class renamed upstream breaks pages silently. Mitigation: snapshot tests per component and the runtime check in light and dark.

## How we check it

- Guard tests under `apps/web`: no hex colours, no Tailwind palette classes, no font size under 12px, no raw `z-index`, no `transition: all`, no inline `style=`, and no `raw(`, `dangerouslySetInnerHTML` or `` html` `` under `apps/web/src`.
- Snapshot per component against the reference markup, light and dark; hashed assets and a manifest; the fonts and the OFL notice are present; nothing else under `apps/web/design-system/` than the files listed above.
- Page tests per state (spec V6a to V6c), including a hostile seller title with `<a href=...>`, `"><script>` and `javascript:` that renders as text and adds no link.
- dependency-cruiser keeps `apps/web` off `packages/ebay`, `@ebay-sniper/db/queue` and every file of `packages/llm` but `catalog.ts`, and checks that nothing `apps/web` imports reaches `packages/llm/src/adapter.ts` or pg-boss.
- Before handing over: one runtime check with `agent-browser` in light and dark, at 320 px, keyboard only and at 200 % zoom.

## Revisit when

- A screen needs live client state that a form post cannot give.
- Intra AI publishes a licence for the design system, or the system moves to new class names.
- More than about 10 people use the UI, or a native app is planned.
