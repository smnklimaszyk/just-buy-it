// Feedback: Badge, StatusDot, Banner, Callout, Toast, ToastRegion, Meter, EmptyState, ErrorState.
// Same markup as the design system's feedback.tsx; the Meter fill is an SVG rect (no inline styles).
import { ButtonLink, Icon } from "./core.js";
import type { IconName } from "./icon-names.js";
import { cx, T, type Child } from "./shared.js";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export type StatusTone = Exclude<Tone, "neutral">;

const TONE_ICON: Record<StatusTone, IconName> = {
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  danger: "circle-alert",
};

export interface BadgeProps {
  tone?: Tone;
  /** An icon of its own, or false for none. Status tones get their tone icon by default. */
  icon?: IconName | false;
  children?: Child;
}

export function Badge({ tone = "neutral", icon, children }: BadgeProps) {
  const ic = icon === false ? null : (icon ?? (tone !== "neutral" ? TONE_ICON[tone] : null));
  return (
    <span class={cx("ia-badge", T.caption, `ia-badge--${tone}`)}>
      {ic && <Icon name={ic} size={12} strokeWidth={2} />}
      {children}
    </span>
  );
}

export interface StatusDotProps {
  tone?: Tone;
  label: Child;
  pulse?: boolean;
}

export function StatusDot({ tone = "neutral", label, pulse = false }: StatusDotProps) {
  return (
    <span class={cx("ia-dot-wrap", T.bodySm)}>
      <span class={cx("ia-dot", `ia-dot--${tone}`, pulse && "is-pulse")} aria-hidden="true" />
      {label}
    </span>
  );
}

export interface ToastProps {
  tone?: Tone;
  title: Child;
  description?: Child;
}

export function Toast({ tone = "neutral", title, description }: ToastProps) {
  const ic = tone === "neutral" ? null : TONE_ICON[tone];
  return (
    <div class={cx("ia-toast", `ia-toast--${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      {ic && <Icon name={ic} size={16} className="ia-toast__icon" />}
      <div class="ia-toast__body">
        <p class={cx("ia-toast__title", T.strong)}>{title}</p>
        {description && <p class={cx("ia-toast__desc", T.bodySm)}>{description}</p>}
      </div>
    </div>
  );
}

/** Bottom right; app.css fades a toast out after 5 s without script. */
export function ToastRegion({ children }: { children?: Child }) {
  return (
    <section class="app-toasts" aria-label="Notifications">
      {children}
    </section>
  );
}

export interface BannerProps {
  tone?: StatusTone;
  title?: Child;
  action?: Child;
  children?: Child;
}

export function Banner({ tone = "info", title, children, action }: BannerProps) {
  return (
    <div class={cx("ia-banner", `ia-banner--${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={TONE_ICON[tone]} size={16} className="ia-banner__icon" />
      <p class={cx("ia-banner__text", T.body)}>
        {title && <strong class={T.strong}>{title} </strong>}
        {children}
      </p>
      {action}
    </div>
  );
}

export interface CalloutProps {
  tone?: StatusTone;
  title?: Child;
  children?: Child;
}

export function Callout({ tone = "info", title, children }: CalloutProps) {
  return (
    <aside class={cx("ia-callout", `ia-callout--${tone}`)}>
      <Icon name={TONE_ICON[tone]} size={16} className="ia-callout__icon" />
      <div>
        {title && <p class={cx(T.strong, "ia-callout__title")}>{title}</p>}
        <div class={cx(T.bodySm, "ia-callout__body")}>{children}</div>
      </div>
    </aside>
  );
}

export interface MeterProps {
  value: number;
  max: number;
  label: string;
  format?: (n: number) => string;
  warnAt?: number;
  dangerAt?: number;
  caption?: Child;
}

const formatNumber = (n: number) => n.toLocaleString("en-GB");

/** A measured amount against a limit. Neutral below 80 %, warning from 80 %, danger from 95 %. */
export function Meter({ value, max, label, format = formatNumber, warnAt = 0.8, dangerAt = 0.95, caption }: MeterProps) {
  const r = Math.min(value / max, 1);
  const tone = r >= dangerAt ? "danger" : r >= warnAt ? "warning" : "neutral";
  return (
    <div class={cx("ia-meter", `ia-meter--${tone}`)}>
      <div class="ia-meter__top">
        <span class={T.label}>{label}</span>
        <span class={cx(T.bodySm, "ia-num ia-meter__val")}>
          {format(value)} / {format(max)}
        </span>
      </div>
      <meter min={0} max={max} value={value} low={max * warnAt} high={max * dangerAt} optimum={0} aria-label={label} class="ia-meter__bar" />
      <div class="ia-meter__track" aria-hidden="true">
        <svg class="ia-meter__fill" width="100%" height="100%" preserveAspectRatio="none" focusable="false">
          <rect width={`${Number((r * 100).toFixed(2))}%`} height="100%" />
        </svg>
      </div>
      {(caption || tone !== "neutral") && (
        <p class={cx(T.caption, "ia-meter__cap")}>
          {tone !== "neutral" && <Icon name={TONE_ICON[tone]} size={12} strokeWidth={2} />}
          {caption}
        </p>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  icon?: IconName;
  title: Child;
  description?: Child;
  action?: Child;
  secondary?: Child;
  align?: "center" | "start";
}

export function EmptyState({ icon = "inbox", title, description, action, secondary, align = "center" }: EmptyStateProps) {
  return (
    <div class={cx("ia-empty", align === "start" && "ia-empty--start")}>
      <Icon name={icon} size={20} className="ia-empty__icon" />
      <p class={cx(T.titleSm, "ia-empty__title")}>{title}</p>
      {description && <p class={cx(T.body, "ia-empty__desc")}>{description}</p>}
      {(action || secondary) && (
        <div class="ia-empty__actions">
          {action}
          {secondary}
        </div>
      )}
    </div>
  );
}

export interface ErrorStateProps {
  title?: Child;
  description?: Child;
  /** A "Try again" link, the primary action of the view. */
  retryHref?: string;
  secondary?: Child;
}

export function ErrorState({ title = "This page didn’t load", description, retryHref, secondary }: ErrorStateProps) {
  return (
    <div class="ia-errstate" role="alert">
      <Icon name="circle-alert" size={20} className="ia-errstate__icon" />
      <h2 class={cx(T.title, "ia-errstate__title")}>{title}</h2>
      {description && <p class={cx(T.body, "ia-errstate__desc")}>{description}</p>}
      <div class="ia-empty__actions">
        {retryHref && (
          <ButtonLink href={retryHref} variant="primary" iconStart="rotate-ccw">
            Try again
          </ButtonLink>
        )}
        {secondary}
      </div>
    </div>
  );
}
