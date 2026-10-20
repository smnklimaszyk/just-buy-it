import { serve } from "@hono/node-server";
import { createAppTokenCache, createPublicKeyClient } from "@ebay-sniper/ebay";
import { createLogger, loggerOptions } from "@ebay-sniper/logging";
import { createApp, type IncomingNotification } from "./app.js";
import { systemClock } from "./clock.js";
import { loadEnv } from "./env.js";
import { limitConcurrency, processNotification } from "./notifications.js";

const logger = createLogger(loggerOptions("info"));
const env = loadEnv();

const { ebayClientId, ebayClientSecret } = env;
const getKey =
  ebayClientId && ebayClientSecret
    ? createPublicKeyClient({
        apiBase: env.ebayApiBase,
        token: createAppTokenCache({
          apiBase: env.ebayApiBase,
          clientId: ebayClientId,
          clientSecret: ebayClientSecret,
          fetchFn: fetch,
          clock: systemClock,
        }),
        fetchFn: fetch,
        clock: systemClock,
      }).getKey
    : async () => {
        throw new Error("eBay client credentials are not configured");
      };

const handleNotification = limitConcurrency(
  20,
  (incoming: IncomingNotification) =>
    processNotification(incoming, { getKey, log: (entry) => logger.info(entry) }).catch((error: unknown) =>
      logger.error({ event: "ebay_account_deletion", err: error }, "notification processing failed"),
    ),
  () => logger.warn({ event: "ebay_account_deletion", verified: false, reason: "dropped, too many in progress" }),
);

const app = createApp({
  endpointUrl: env.deletionEndpointUrl,
  verificationToken: env.deletionVerificationToken,
  gitSha: env.gitSha,
  onNotification: handleNotification,
});

const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) =>
  logger.info({ port: info.port, credentials: Boolean(ebayClientId && ebayClientSecret) }, "server listening"),
);

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
