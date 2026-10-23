// The page frame around the design system components: the document shell and the theme toggle.
import type { AssetManifest, ClientScript } from "./assets.js";
import { Icon } from "./core.js";
import { cx, T, type Child } from "./shared.js";

export type Theme = "light" | "dark";

export interface DocumentProps {
  title: string;
  theme: Theme;
  assets: AssetManifest;
  /** The page scripts this page uses. */
  scripts?: ClientScript[];
  /** Read-only pages only; on a form it would wipe the input. `url` is a path on this site. */
  refresh?: { seconds: number; url: string; withoutScriptOnly?: boolean };
  children?: Child;
}

/** The whole page as HTML text, doctype first. */
export function renderDocument({ title, theme, assets, scripts = [], refresh, children }: DocumentProps): string {
  return `<!doctype html>${String(
    <html lang="en" data-theme={theme}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content={theme} />
        <title>{title} - Just-Buy-It</title>
        {refresh &&
          (refresh.withoutScriptOnly ? (
            <noscript>
              <meta http-equiv="refresh" content={`${refresh.seconds};url=${refresh.url}`} />
            </noscript>
          ) : (
            <meta http-equiv="refresh" content={`${refresh.seconds};url=${refresh.url}`} />
          ))}
        <link rel="stylesheet" href={assets.styles} />
        <link rel="preload" href={assets.fonts.geist} as="font" type="font/woff2" crossorigin="anonymous" />
        {scripts.map((s) => (
          <script type="module" src={assets.scripts[s]} />
        ))}
      </head>
      <body>
        <a class="app-skip" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>,
  )}`;
}

export interface ThemeToggleProps {
  theme: Theme;
  csrfToken: string;
  /** Where POST /theme sends the browser back to (the page has no Referer: no-referrer). */
  back: string;
}

/**
 * A sidebar row that posts the other theme to POST /theme. Both icons and labels are in the
 * markup and app.css shows the ones for the current data-theme, so theme.ts only flips the
 * attribute and the hidden value.
 */
export function ThemeToggle({ theme, csrfToken, back }: ThemeToggleProps) {
  return (
    <form method="post" action="/theme" data-theme-toggle="">
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="theme" value={theme === "dark" ? "light" : "dark"} />
      <input type="hidden" name="back" value={back} />
      <div class="ia-side-row">
        <button type="submit" class={cx("ia-side", T.body)}>
          <Icon name="moon" size={16} className="ia-side__icon app-when-light" />
          <Icon name="sun" size={16} className="ia-side__icon app-when-dark" />
          <span class="ia-side__label">
            <span class="app-when-light">Dark theme</span>
            <span class="app-when-dark">Light theme</span>
          </span>
        </button>
      </div>
    </form>
  );
}
