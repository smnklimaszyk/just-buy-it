// Foundation and actions: Icon, Spinner, Button, IconButton, Link, Separator.
// Same markup as the design system's core.tsx and shared.tsx, rendered on the server.
import { readFileSync } from "node:fs";
import { jsx } from "hono/jsx";
import type { ButtonProps as DsButtonProps } from "../../design-system/components/index.js";
import type { IconName } from "./icon-names.js";
import { cx, T, type Child } from "./shared.js";

type IconParts = [tag: string, attrs: Record<string, string>][];

const ICONS = JSON.parse(readFileSync(new URL("../../design-system/icons.json", import.meta.url), "utf8")) as Record<
  IconName,
  IconParts
>;

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Only when the icon carries meaning alone. */
  label?: string;
}

/** Lucide line icon, stroke 1.75 by default. */
export function Icon({ name, size = 16, strokeWidth = 1.75, className, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cx("ia-icon", className)}
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      {ICONS[name].map(([tag, attrs]) => jsx(tag, attrs))}
    </svg>
  );
}

export interface SpinnerProps {
  size?: number;
  label?: string;
}

/** The reference sizes the wrapper inline; here the svg's own width and height do it (no inline styles). */
export function Spinner({ size = 16, label }: SpinnerProps) {
  return (
    <span class="ia-spinner" role={label ? "status" : undefined} aria-label={label}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.75" />
        <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
      </svg>
    </span>
  );
}

export type ButtonVariant = NonNullable<DsButtonProps["variant"]>;
export type ButtonSize = NonNullable<DsButtonProps["size"]>;

export interface ButtonProps {
  /** primary: the one main action per view. secondary: default. quiet: toolbars. danger: destructive confirm only. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Width never changes: replaces iconStart, or overlays the label when there is no icon. */
  loading?: boolean;
  iconStart?: IconName;
  iconEnd?: IconName;
  fullWidth?: boolean;
  type?: "button" | "submit" | "reset";
  name?: string;
  value?: string;
  disabled?: boolean;
  autofocus?: boolean;
  form?: string;
  formaction?: string;
  className?: string;
  /** Opens or closes a <dialog> without script (invoker commands). */
  commandfor?: string;
  command?: "show-modal" | "close" | "request-close";
  children?: Child;
}

const btnType = (size: ButtonSize) => (size === "lg" ? T.strongLg : size === "sm" ? T.label : T.strong);
const iconSize = (size: ButtonSize) => (size === "lg" ? 18 : 16);

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  iconStart,
  iconEnd,
  fullWidth,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const overlay = loading && !iconStart;
  return (
    <button
      type={type}
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      class={cx(
        "ia-btn",
        btnType(size),
        `ia-btn--${variant}`,
        `ia-btn--${size}`,
        fullWidth && "ia-btn--full",
        overlay && "is-overlay-loading",
        className,
      )}
    >
      {iconStart ? loading ? <Spinner size={iconSize(size)} /> : <Icon name={iconStart} size={iconSize(size)} /> : null}
      <span class="ia-btn__label">{children}</span>
      {iconEnd ? <Icon name={iconEnd} size={iconSize(size)} /> : null}
      {overlay && (
        <span class="ia-btn__spin">
          <Spinner size={iconSize(size)} />
        </span>
      )}
    </button>
  );
}

export interface ButtonLinkProps {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconStart?: IconName;
  iconEnd?: IconName;
  fullWidth?: boolean;
  className?: string;
  children?: Child;
}

/** A link that looks like a Button, for actions that open a page ("Add product", "Edit product"). */
export function ButtonLink({ href, variant = "secondary", size = "md", iconStart, iconEnd, fullWidth, className, children }: ButtonLinkProps) {
  return (
    <a href={href} class={cx("ia-btn", btnType(size), `ia-btn--${variant}`, `ia-btn--${size}`, fullWidth && "ia-btn--full", className)}>
      {iconStart ? <Icon name={iconStart} size={iconSize(size)} /> : null}
      <span class="ia-btn__label">{children}</span>
      {iconEnd ? <Icon name={iconEnd} size={iconSize(size)} /> : null}
    </a>
  );
}

export interface IconButtonProps {
  icon: IconName;
  /** Required accessible name, also the tooltip. */
  label: string;
  variant?: "quiet" | "secondary" | "primary";
  size?: "sm" | "md";
  shape?: "rect" | "round";
  pressed?: boolean;
  type?: "button" | "submit";
  name?: string;
  value?: string;
  disabled?: boolean;
  className?: string;
  /** Renders a link that looks like the button (drawer toggle, pagination). */
  href?: string;
  commandfor?: string;
  command?: "show-modal" | "close" | "request-close";
  "aria-haspopup"?: "menu";
  "aria-expanded"?: "true" | "false";
  "aria-controls"?: string;
}

export function IconButton({ icon, label, variant = "quiet", size = "md", shape = "rect", pressed, className, href, type = "button", ...rest }: IconButtonProps) {
  const cls = cx(
    "ia-iconbtn",
    `ia-iconbtn--${variant}`,
    `ia-iconbtn--${size}`,
    shape === "round" && "ia-iconbtn--round",
    pressed && "is-on",
    className,
  );
  const glyph = <Icon name={icon} size={size === "sm" ? 16 : 18} />;
  if (href !== undefined) {
    return (
      <a href={href} aria-label={label} title={label} class={cls}>
        {glyph}
      </a>
    );
  }
  return (
    <button
      type={type}
      {...rest}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : String(pressed)}
      title={label}
      class={cls}
    >
      {glyph}
    </button>
  );
}

export interface LinkProps {
  href: string;
  external?: boolean;
  subtle?: boolean;
  className?: string;
  children?: Child;
}

export function Link({ href, children, external = false, subtle = false, className }: LinkProps) {
  return (
    <a
      href={href}
      class={cx("ia-link", subtle && "ia-link--subtle", className)}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer noopener" : undefined}
    >
      {children}
      {external && <Icon name="arrow-up-right" size={14} className="ia-link__ext" />}
      {external && <span class="ia-sr">(opens in a new tab)</span>}
    </a>
  );
}

export interface SeparatorProps {
  orientation?: "horizontal" | "vertical";
}

export function Separator({ orientation = "horizontal" }: SeparatorProps) {
  return <div class={cx("ia-sep", orientation === "vertical" && "ia-sep--v")} role="separator" aria-orientation={orientation} />;
}
