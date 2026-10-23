// Data display: Table, DescriptionList, StatTile, Surface. Same markup as the design system's data.tsx.
import { Icon } from "./core.js";
import { cx, T, type Child } from "./shared.js";

export interface TableColumn<R> {
  key: string;
  label: Child;
  numeric?: boolean;
  mono?: boolean;
  /** The first column as the row's header cell (<th scope="row">). */
  rowHeader?: boolean;
  render?: (row: R) => Child;
}

export interface TableProps<R> {
  columns: TableColumn<R>[];
  rows: R[];
  /** Read by screen readers; hidden on screen. */
  caption: string;
  density?: "sm" | "md";
  stickyHeader?: boolean;
  /** Says what will appear here. */
  empty?: Child;
}

export function Table<R extends object>({ columns, rows, caption, density = "md", stickyHeader = false, empty }: TableProps<R>) {
  return (
    <div class={cx("ia-table-wrap", stickyHeader && "is-sticky")}>
      <table class={cx("ia-table", `ia-table--${density}`)}>
        <caption class="ia-sr">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th scope="col" class={cx(T.label, c.numeric && "is-num")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colspan={columns.length} class={cx("ia-table__empty", T.body)}>
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr>
              {columns.map((c, ci) => {
                const content = c.render ? c.render(r) : (r as Record<string, Child>)[c.key];
                const cls = cx(c.mono ? T.codeSm : T.bodySm, c.numeric && "is-num", ci === 0 && "is-first");
                return ci === 0 && c.rowHeader ? (
                  <th scope="row" class={cls}>
                    {content}
                  </th>
                ) : (
                  <td class={cls}>{content}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface DescriptionListProps {
  items: { label: Child; value: Child; mono?: boolean; numeric?: boolean }[];
  layout?: "row" | "stack";
}

export function DescriptionList({ items, layout = "row" }: DescriptionListProps) {
  return (
    <dl class={cx("ia-dl", `ia-dl--${layout}`)}>
      {items.map((it) => (
        <div class="ia-dl__item">
          <dt class={T.label}>{it.label}</dt>
          <dd class={cx(it.mono ? T.codeSm : T.body, it.numeric && "ia-num")}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface StatTileProps {
  label: Child;
  value: Child;
  unit?: Child;
  delta?: Child;
  deltaLabel?: Child;
  trend?: "up-good" | "up-bad" | "down-good" | "down-bad";
  caption?: Child;
}

/** Only measured numbers. */
export function StatTile({ label, value, unit, delta, deltaLabel, trend, caption }: StatTileProps) {
  const good = trend === "up-good" || trend === "down-good";
  const up = trend?.startsWith("up");
  return (
    <div class="ia-stat">
      <p class={cx(T.label, "ia-stat__label")}>{label}</p>
      <p class="ia-stat__value">
        <span class={cx(T.headlineSm, "ia-num")}>{value}</span>
        {unit && <span class={cx(T.bodySm, "ia-stat__unit")}>{unit}</span>}
      </p>
      {delta && (
        <p class={cx(T.bodySm, "ia-stat__delta", trend && (good ? "is-good" : "is-bad"))}>
          {trend && <Icon name={up ? "trending-up" : "trending-down"} size={14} />}
          <span class="ia-num">{delta}</span> {deltaLabel}
        </p>
      )}
      {caption && <p class={cx(T.caption, "ia-stat__cap")}>{caption}</p>}
    </div>
  );
}

export interface SurfaceProps {
  title?: Child;
  description?: Child;
  footer?: Child;
  href?: string;
  interactive?: boolean;
  padding?: "sm" | "md" | "lg";
  children?: Child;
}

/** A bordered unit someone chooses or acts on. Not everything is a card. */
export function Surface({ title, description, children, interactive = false, href, footer, padding = "md" }: SurfaceProps) {
  const cls = cx("ia-surface", `ia-surface--${padding}`, interactive && "is-interactive");
  const content = [
    (title || description) && (
      <div class="ia-surface__head">
        {title && <h3 class={cx("ia-surface__title", T.titleSm)}>{title}</h3>}
        {description && <p class={cx("ia-surface__desc", T.body)}>{description}</p>}
      </div>
    ),
    children && <div class={cx("ia-surface__body", T.body)}>{children}</div>,
    footer && <div class="ia-surface__foot">{footer}</div>,
  ];
  return href !== undefined ? (
    <a href={href} class={cls}>
      {content}
    </a>
  ) : (
    <section class={cls}>{content}</section>
  );
}
