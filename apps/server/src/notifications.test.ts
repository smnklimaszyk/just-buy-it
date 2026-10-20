import { createAppTokenCache, createPublicKeyClient, EbayError, type KeyLookup } from "@ebay-sniper/ebay";
import { describe, expect, it } from "vitest";
import { createNotificationWork, processNotification, type LookupKey } from "./notifications.js";
import { createSigner, notificationBody, USER_SENTINELS } from "./testing/signed.js";

const signer = createSigner();
const body = notificationBody();
const notificationId = body.notification.notificationId;
const keyFound = async (): Promise<KeyLookup> => ({ kind: "key", key: signer.publicKey, stale: false });

function classify(incoming: Parameters<typeof processNotification>[0], lookupKey: LookupKey = keyFound) {
  return processNotification(incoming, { lookupKey, signal: new AbortController().signal });
}

describe("processNotification results", () => {
  it("returns a verified event with the four audit fields and nothing else", async () => {
    const signedBody = notificationBody();

    const classified = await processNotification(signer.signed(signedBody), {
      lookupKey: async () => ({ kind: "key", key: signer.publicKey, stale: false }),
      signal: new AbortController().signal,
    });

    expect(classified).toEqual({
      result: "verified",
      event: {
        notificationId: signedBody.notification.notificationId,
        topic: "MARKETPLACE_ACCOUNT_DELETION",
        eventDate: new Date(signedBody.notification.eventDate),
        publishAttemptCount: 1,
      },
    });
  });
});

describe("processNotification", () => {
  it("returns a verified result without any user identifier", async () => {
    const classified = await classify(signer.signed(body));

    expect(classified.result).toBe("verified");
    expect(JSON.stringify(classified)).not.toMatch(new RegExp(USER_SENTINELS.join("|")));
  });

  it("counts a notification without signature header as malformed", async () => {
    expect(await classify({ rawBody: JSON.stringify(body), signatureHeader: undefined })).toEqual({
      result: "malformed",
      notificationId,
    });
  });

  it("counts a body that is not valid JSON as malformed instead of throwing", async () => {
    expect(await classify({ rawBody: "{not json", signatureHeader: signer.header(body) })).toEqual({
      result: "malformed",
    });
  });

  it("counts JSON without the notification shape as malformed", async () => {
    expect(await classify(signer.signed({ hello: "world" }))).toEqual({ result: "malformed" });
  });

  it("counts a signature header that does not parse as malformed", async () => {
    const header = Buffer.from('{"kid":"secret-from-attacker"').toString("base64");

    expect(await classify({ rawBody: JSON.stringify(body), signatureHeader: header })).toEqual({
      result: "malformed",
      notificationId,
    });
  });

  it("does not return an oversized notification id", async () => {
    const flood = notificationBody({ notificationId: "x".repeat(60_000) });

    expect(await classify(signer.signed(flood))).toEqual({ result: "malformed" });
  });

  it("counts a failed key lookup as key_unavailable with the eBay error kind", async () => {
    const unavailable = async (): Promise<KeyLookup> => ({
      kind: "unavailable",
      error: new EbayError({ kind: "unauthorized", operation: "token", status: 401, attempts: 1 }),
    });

    expect(await classify(signer.signed(body), unavailable)).toEqual({
      result: "key_unavailable",
      notificationId,
      errKind: "unauthorized",
    });
  });

  it.each([
    [{ kind: "rejected" }, "key_rejected"],
    [{ kind: "limited" }, "key_fetch_limited"],
  ] as const)("maps the lookup answer %o to %s", async (lookup, result) => {
    expect(await classify(signer.signed(body), async () => lookup)).toEqual({ result, notificationId });
  });

  it.each([
    ["a body changed after signing", { rawBody: JSON.stringify(notificationBody({ publishAttemptCount: 2 })), signatureHeader: signer.header(body) }, signer.publicKey],
    ["signature bytes that are not a signature", signer.signed(body, { signature: "AAAA" }), signer.publicKey],
    ["a key Node cannot parse", signer.signed(body), "-----BEGIN PUBLIC KEY-----bm90IGEga2V5-----END PUBLIC KEY-----"],
  ])("counts %s as bad_signature", async (_name, incoming, key) => {
    expect(await classify(incoming, async () => ({ kind: "key", key, stale: false }))).toEqual({
      result: "bad_signature",
      notificationId,
    });
  });

  it.each([
    ["an eventDate that is not an ISO date", notificationBody({ eventDate: "yesterday" })],
    ["a publishAttemptCount that is not a whole number", notificationBody({ publishAttemptCount: 1.5 })],
    ["an empty topic", notificationBody({ topic: "" })],
  ])("counts %s as malformed without a key lookup", async (_name, payload) => {
    let lookups = 0;
    const lookupKey = async (): Promise<KeyLookup> => {
      lookups += 1;
      return { kind: "key", key: signer.publicKey, stale: false };
    };

    expect(await classify(signer.signed(payload), lookupKey)).toEqual({ result: "malformed" });
    expect(lookups).toBe(0);
  });

  it("sends a key id of 128 printable characters to eBay as one encoded path segment", async () => {
    const kid = `a/b%2F c..${"x".repeat(118)}`;
    const urls: string[] = [];
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/identity/v1/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
      return Response.json({ key: signer.publicKey });
    };
    const clock = { now: () => new Date(0) };
    const apiBase = "https://api.ebay.com";
    const token = createAppTokenCache({ apiBase, clientId: "id", clientSecret: "secret", fetchFn, clock });
    const { lookupKey } = createPublicKeyClient({ apiBase, token, fetchFn, clock });

    const classified = await classify(signer.signed(body, { kid }), lookupKey);

    expect(classified.result).toBe("verified");
    const keyUrl = new URL(urls.find((url) => url.includes("/public_key/")) ?? "");
    expect(keyUrl.pathname).toBe(`/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`);
    expect(decodeURIComponent(keyUrl.pathname.split("/").at(-1) ?? "")).toBe(kid);
  });

  it("passes the key id and the signal to the lookup and verifies with a stale key", async () => {
    const signal = new AbortController().signal;
    const calls: [string, AbortSignal | undefined][] = [];
    const lookupKey = async (kid: string, given?: AbortSignal): Promise<KeyLookup> => {
      calls.push([kid, given]);
      return { kind: "key", key: signer.publicKey, stale: true };
    };

    const classified = await processNotification(signer.signed(body), { lookupKey, signal });

    expect(classified.result).toBe("verified");
    expect(calls).toEqual([[signer.kid, signal]]);
  });

  it("counts an unsupported algorithm without a key lookup", async () => {
    let lookups = 0;
    const lookupKey = async (): Promise<KeyLookup> => {
      lookups += 1;
      return { kind: "key", key: signer.publicKey, stale: false };
    };

    expect(await classify(signer.signed(body, { alg: "rsa" }), lookupKey)).toEqual({
      result: "unsupported_alg",
      notificationId,
    });
    expect(lookups).toBe(0);
  });
});

describe("createNotificationWork", () => {
  it("logs a verified notification before it records it, and logs the saved outcome", async () => {
    const steps: unknown[] = [];
    const work = createNotificationWork({
      lookupKey: keyFound,
      countResult: (result) => steps.push(["count", result]),
      recordVerified: async (...args) => {
        steps.push(["record", ...args]);
        return "inserted";
      },
      log: { info: (entry) => steps.push(["info", entry]), warn: (entry) => steps.push(["warn", entry]) },
      clock: { now: () => new Date("2026-10-20T10:00:00Z") },
    });

    await work(signer.signed(body), {
      signal: new AbortController().signal,
      classified: () => steps.push(["classified"]),
    });

    const event = {
      notificationId,
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      eventDate: new Date(body.notification.eventDate),
      publishAttemptCount: 1,
    };
    expect(steps).toEqual([
      [
        "info",
        {
          event: "ebay_account_deletion",
          result: "verified",
          notificationId,
          topic: "MARKETPLACE_ACCOUNT_DELETION",
          eventDate: body.notification.eventDate,
          publishAttemptCount: 1,
        },
      ],
      ["classified"],
      ["record", event],
      ["info", { event: "ebay_account_deletion_saved", notificationId, saved: true, outcome: "inserted" }],
    ]);
    expect(JSON.stringify(steps)).not.toMatch(new RegExp(USER_SENTINELS.join("|")));
  });

  it.each([
    ["the SQLSTATE", Object.assign(new Error("permission denied for table deletion_event"), { code: "42501" }), "42501"],
    ["timeout", new Error("Query read timeout"), "timeout"],
    ["timeout for a connection that never came", new Error("timeout exceeded when trying to connect"), "timeout"],
    ["the Node error code", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
    ["unknown for anything else", new Error("Connection terminated unexpectedly"), "unknown"],
  ])("logs a failed insert with %s and never the message", async (_name, error, errCode) => {
    const run = workHarness({ recordVerified: async () => Promise.reject(error) });

    await run.work(signer.signed(body), run.context);

    expect(run.warnings).toEqual([{ event: "ebay_account_deletion_saved", notificationId, saved: false, err_code: errCode }]);
    expect(run.infos).toHaveLength(1);
  });

  it("counts a non-verified result once, marks the item classified and writes no line for malformed", async () => {
    const run = workHarness();

    await run.work({ rawBody: "{not json", signatureHeader: undefined }, run.context);

    expect(run.counted).toEqual(["malformed"]);
    expect(run.classifiedCalls()).toBe(1);
    expect([...run.infos, ...run.warnings]).toEqual([]);
  });

  it.each([
    [
      { kind: "unavailable", error: new EbayError({ kind: "timeout", operation: "public_key", attempts: 3 }) },
      { event: "ebay_account_deletion", result: "key_unavailable", notificationId, err_kind: "timeout" },
    ],
    [{ kind: "limited" }, { event: "ebay_account_deletion", result: "key_fetch_limited", notificationId }],
  ] as const)("writes one warn line with the notification id for %o", async (lookup, line) => {
    const run = workHarness({ lookupKey: async () => lookup });

    await run.work(signer.signed(body), run.context);

    expect(run.counted).toEqual([line.result]);
    expect(run.warnings).toEqual([line]);
    expect(JSON.stringify(run.warnings)).not.toMatch(new RegExp(USER_SENTINELS.join("|")));
  });

  it("stops the key lines after 1,000 in one UTC hour, keeps counting, and writes again the next hour", async () => {
    let calls = 0;
    const lookupKey = async (): Promise<KeyLookup> => {
      calls += 1;
      return calls % 2 === 0
        ? { kind: "limited" }
        : { kind: "unavailable", error: new EbayError({ kind: "server_error", operation: "public_key", attempts: 2 }) };
    };
    const run = workHarness({ lookupKey });
    run.now.value = new Date("2026-10-20T10:00:00.000Z").getTime();

    for (let i = 0; i < 1_001; i += 1) await run.work(signer.signed(body), run.context);
    expect(run.warnings).toHaveLength(1_000);
    expect(run.counted).toHaveLength(1_001);

    run.now.value = new Date("2026-10-20T10:59:59.999Z").getTime();
    await run.work(signer.signed(body), run.context);
    expect(run.warnings).toHaveLength(1_000);

    run.now.value = new Date("2026-10-20T11:00:00.000Z").getTime();
    await run.work(signer.signed(body), run.context);
    expect(run.warnings).toHaveLength(1_001);
    expect(run.counted).toHaveLength(1_003);
  });

  it.each([
    ["a lookup that ends unavailable", { kind: "unavailable", error: new EbayError({ kind: "aborted", operation: "public_key", attempts: 0 }) }],
    ["a lookup that finds the key", { kind: "key", key: signer.publicKey, stale: false }],
  ] as const)("does nothing with %s once the drain has aborted the signal, since it counted the item", async (_name, lookup) => {
    let recorded = 0;
    const drain = new AbortController();
    const run = workHarness({
      lookupKey: async () => {
        drain.abort();
        return lookup;
      },
      recordVerified: async () => {
        recorded += 1;
        return "inserted";
      },
    });

    await run.work(signer.signed(body), { signal: drain.signal, classified: run.context.classified });

    expect(run.counted).toEqual([]);
    expect(run.classifiedCalls()).toBe(0);
    expect([...run.infos, ...run.warnings]).toEqual([]);
    expect(recorded).toBe(0);
  });
});

function workHarness(overrides: Partial<Parameters<typeof createNotificationWork>[0]> = {}) {
  const infos: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  const counted: string[] = [];
  const now = { value: new Date("2026-10-20T10:00:00Z").getTime() };
  let classifiedCalls = 0;
  const controller = new AbortController();
  const work = createNotificationWork({
    lookupKey: keyFound,
    countResult: (result) => counted.push(result),
    recordVerified: async () => "inserted",
    log: { info: (entry) => infos.push(entry), warn: (entry) => warnings.push(entry) },
    clock: { now: () => new Date(now.value) },
    ...overrides,
  });
  const context = {
    signal: controller.signal,
    classified: () => {
      classifiedCalls += 1;
    },
  };
  return { work, context, controller, infos, warnings, counted, now, classifiedCalls: () => classifiedCalls };
}
