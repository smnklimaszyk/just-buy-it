import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { challengeResponse } from "./deletion.js";
import { privacyHtml } from "./privacy.js";

export type IncomingNotification = { rawBody: string; signatureHeader: string | undefined };

export type AppOptions = {
  endpointUrl: string;
  verificationToken: string;
  gitSha: string;
  // The external probe's challenge code (ADR 0030). Its reply is the same as for any other code.
  probeCode: string;
  onProbe: () => void;
  onNotification: (notification: IncomingNotification) => void;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest();

export function createApp(options: AppOptions) {
  const app = new Hono();
  const probeDigest = sha256(options.probeCode);
  // Equal-length digests, so the comparison leaks neither the code nor its length.
  const isProbe = (code: string) => timingSafeEqual(sha256(code), probeDigest);

  app.get("/healthz", (c) => c.json({ sha: options.gitSha }, 200, { "Cache-Control": "no-store" }));
  // The page loads nothing and posts nothing; only its inline style may apply. The deletion route
  // keeps its own headers.
  app.get("/privacy", (c) =>
    c.html(privacyHtml, 200, {
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
    }),
  );

  app.get("/ebay/account-deletion", (c) => {
    const noStore = { "Cache-Control": "no-store" };
    const code = c.req.query("challenge_code");
    if (!code) return c.json({ error: "challenge_code is required" }, 400, noStore);
    const reply = c.json(
      { challengeResponse: challengeResponse(code, options.verificationToken, options.endpointUrl) },
      200,
      noStore,
    );
    if (isProbe(code)) options.onProbe();
    return reply;
  });

  app.post("/ebay/account-deletion", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    options.onNotification({ rawBody: await c.req.text(), signatureHeader: c.req.header("x-ebay-signature") });
    return c.body(null, 204);
  });

  // ADR 0013: other methods get 405, never 400. HEAD is answered by the GET handler.
  app.all("/ebay/account-deletion", (c) => c.text("Method Not Allowed", 405, { Allow: "GET, POST" }));

  return app;
}
