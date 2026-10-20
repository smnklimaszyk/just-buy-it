import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { challengeResponse } from "./deletion.js";
import { privacyHtml } from "./privacy.js";

export type IncomingNotification = { rawBody: string; signatureHeader: string | undefined };

export type AppOptions = {
  endpointUrl: string;
  verificationToken: string;
  gitSha: string;
  onNotification: (notification: IncomingNotification) => void;
};

export function createApp(options: AppOptions) {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ sha: options.gitSha }, 200, { "Cache-Control": "no-store" }));
  app.get("/privacy", (c) => c.html(privacyHtml));

  app.get("/ebay/account-deletion", (c) => {
    const code = c.req.query("challenge_code");
    if (!code) return c.json({ error: "challenge_code is required" }, 400);
    return c.json({ challengeResponse: challengeResponse(code, options.verificationToken, options.endpointUrl) });
  });

  app.post("/ebay/account-deletion", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    options.onNotification({ rawBody: await c.req.text(), signatureHeader: c.req.header("x-ebay-signature") });
    return c.body(null, 204);
  });

  return app;
}
