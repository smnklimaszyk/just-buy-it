// The hashed asset names scripts/build-assets.ts writes to dist/assets/manifest.json.

/** One module per behaviour in src/client; every page works without them. */
export const CLIENT_SCRIPTS = ["otp", "tags", "dialog", "menu", "form-busy", "theme", "market-poll", "cost-preview"] as const;
export type ClientScript = (typeof CLIENT_SCRIPTS)[number];

export interface AssetManifest {
  /** tokens.css, then components/bundle.css, then app.css, in one file. */
  styles: string;
  fonts: { geist: string; geistItalic: string; geistMono: string };
  scripts: Record<ClientScript, string>;
}
