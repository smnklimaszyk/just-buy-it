import { describe, expect, it } from "vitest";
import { renderDocument, type AssetManifest } from "./index.js";

const assets: AssetManifest = {
  styles: "/assets/styles.0a1b2c3d4e5f.css",
  fonts: {
    geist: "/assets/Geist-Variable.111111111111.woff2",
    geistItalic: "/assets/Geist-Italic-Variable.222222222222.woff2",
    geistMono: "/assets/GeistMono-Variable.333333333333.woff2",
  },
  scripts: {
    otp: "/assets/otp.aaaaaaaaaaaa.js",
    tags: "/assets/tags.bbbbbbbbbbbb.js",
    dialog: "/assets/dialog.cccccccccccc.js",
    menu: "/assets/menu.dddddddddddd.js",
    "form-busy": "/assets/form-busy.eeeeeeeeeeee.js",
    theme: "/assets/theme.ffffffffffff.js",
    "market-poll": "/assets/market-poll.999999999999.js",
    "cost-preview": "/assets/cost-preview.888888888888.js",
  },
};

describe("renderDocument", () => {
  it("writes an English document that carries the theme", () => {
    const html = renderDocument({ title: "Products", theme: "dark", assets, children: <main id="main">Hi</main> });

    expect(html.startsWith(`<!doctype html><html lang="en" data-theme="dark">`)).toBe(true);
  });

  it("loads the hashed stylesheet, preloads the text font and names the page", () => {
    const html = renderDocument({ title: "Products", theme: "light", assets });

    expect(html).toContain(
      `<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="color-scheme" content="light"/><title>Products - Just-Buy-It</title>`,
    );
    expect(html).toContain(`<link rel="stylesheet" href="/assets/styles.0a1b2c3d4e5f.css"/>`);
    expect(html).toContain(`<link rel="preload" href="/assets/Geist-Variable.111111111111.woff2" as="font" type="font/woff2" crossorigin="anonymous"/>`);
  });

  it("loads only the page scripts it is given, as modules, and starts the body with a skip link", () => {
    const html = renderDocument({ title: "Products", theme: "light", assets, scripts: ["dialog", "menu"], children: <main id="main">Hi</main> });

    expect(html).toContain(
      `<script type="module" src="/assets/dialog.cccccccccccc.js"></script><script type="module" src="/assets/menu.dddddddddddd.js"></script></head>`,
    );
    expect(html).not.toContain("otp.");
    expect(html).toContain(`<body><a class="app-skip" href="#main">Skip to content</a><main id="main">Hi</main></body></html>`);
  });

  it("refreshes itself only when the page asks (Overview every 60 s to ?auto=1)", () => {
    const overview = renderDocument({ title: "Overview", theme: "light", assets, refresh: { seconds: 60, url: "/?auto=1" } });
    const form = renderDocument({ title: "Add product", theme: "light", assets });

    expect(overview).toContain(`<meta http-equiv="refresh" content="60;url=/?auto=1"/>`);
    expect(form).not.toContain("http-equiv");
  });

  it("can refresh only without script, where market-poll.ts does the polling (product page during a market check)", () => {
    const html = renderDocument({
      title: "Road bike",
      theme: "light",
      assets,
      scripts: ["market-poll"],
      refresh: { seconds: 5, url: "/products/bike?auto=1", withoutScriptOnly: true },
    });

    expect(html).toContain(`<noscript><meta http-equiv="refresh" content="5;url=/products/bike?auto=1"/></noscript>`);
  });
});
