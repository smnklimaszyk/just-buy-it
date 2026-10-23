import { describe, expect, it } from "vitest";
import { createClaudeScreener, type FetchFn, type ScreeningCall } from "./adapter.js";
import { ClaudeError } from "./failures.js";
import { buildScreeningRequest } from "./request.js";
import { SYSTEM_PROMPT } from "./prompt.v2.js";
import { ANSWER_JSON_SCHEMA, RISK_FLAGS } from "./schema.js";

const API_KEY = "sk-ant-test-SENTINEL_KEY_51c9";
const USER_MESSAGE = '<product>\n{"name":"Portrait lens"}\n</product>\n<listing>\n{\n  "title": "Objektiv 85mm"\n}\n</listing>';
const CALL: ScreeningCall = { model: "claude-sonnet-5-5", effort: "medium", userMessage: USER_MESSAGE };

const ANSWER = { verdict: "pass", product_match: "match", risk_flags: [], reason: "Card matches." };

type Captured = { url: string; init: RequestInit };

// A recorded Messages API response shape with the parts the adapter reads.
function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify(ANSWER) },
    ],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 2400, output_tokens: 900, inference_geo: "global" },
    ...overrides,
  };
}

function fakeFetch(response: () => Response): { fetchFn: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  };
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("Claude adapter", () => {
  it("posts the section 5.3 body with no tools and no fallbacks", async () => {
    const { fetchFn, calls } = fakeFetch(() => json(messageBody()));
    await createClaudeScreener({ apiKey: API_KEY, fetchFn }).screen(CALL);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 3000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: ANSWER_JSON_SCHEMA } },
      inference_geo: "global",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: USER_MESSAGE }],
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("fallbacks");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the answer of the last text block with usage, cost and the inference geography", async () => {
    const content = [
      { type: "text", text: "not the answer" },
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify({ ...ANSWER, verdict: "PASS", risk_flags: ["Mining_History"] }) },
    ];
    const { fetchFn } = fakeFetch(() => json(messageBody({ content })));
    const result = await createClaudeScreener({ apiKey: API_KEY, fetchFn }).screen(CALL);
    expect(result).toEqual({
      answer: { verdict: "pass", productMatch: "match", riskFlags: ["mining_history"], reason: "Card matches." },
      model: "claude-sonnet-5-5",
      usage: { inputTokens: 2400, outputTokens: 900 },
      costMicroUsd: 2400 * 2 + 900 * 10,
      inferenceGeo: "global",
    });
  });

  it("maps stop_reason max_tokens to truncated, never retried, with the usage that was billed", async () => {
    const { fetchFn } = fakeFetch(() =>
      json(messageBody({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"verdict":"pa' }], usage: { input_tokens: 2000, output_tokens: 3000 } })),
    );
    const error = await screenError(fetchFn);
    expect(error).toMatchObject({
      code: "truncated",
      retryable: false,
      status: 200,
      retryAfterSeconds: null,
      usage: { inputTokens: 2000, outputTokens: 3000 },
      costMicroUsd: 2000 * 2 + 3000 * 10,
    });
  });

  it("maps stop_reason refusal to refused, never retried", async () => {
    const { fetchFn } = fakeFetch(() =>
      json(messageBody({ stop_reason: "refusal", stop_details: { type: "refusal", category: null }, content: [] })),
    );
    expect(await screenError(fetchFn)).toMatchObject({ code: "refused", retryable: false, usage: { inputTokens: 2400 } });
  });

  it.each([
    ["text that is not JSON", [{ type: "text", text: "Verdict: pass" }]],
    ["13 risk flags", [{ type: "text", text: JSON.stringify({ ...ANSWER, risk_flags: RISK_FLAGS.slice(0, 13) }) }]],
    ["no text block", [{ type: "thinking", thinking: "", signature: "sig" }]],
  ])("maps %s to schema_invalid, retried once, with usage", async (_case, content) => {
    const { fetchFn } = fakeFetch(() => json(messageBody({ content })));
    expect(await screenError(fetchFn)).toMatchObject({ code: "schema_invalid", retryable: true, usage: { outputTokens: 900 } });
  });

  it("sends the call's model and effort, prices the usage at that model, and refuses an answer from another one", async () => {
    const haiku: ScreeningCall = { model: "claude-haiku-5-5", effort: "low", userMessage: USER_MESSAGE };
    const answered = fakeFetch(() => json(messageBody({ model: "claude-haiku-5-5" })));
    const result = await createClaudeScreener({ apiKey: API_KEY, fetchFn: answered.fetchFn }).screen(haiku);
    expect(JSON.parse(String(answered.calls[0]?.init.body))).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low" },
    });
    // 2,400 x 0.1 + 900 x 0.5 micro-USD.
    expect(result).toMatchObject({ model: "claude-haiku-5-5", costMicroUsd: 690 });
    // The Sonnet answer of messageBody() to a Haiku request: settings or the candidate asked for Haiku.
    const other = fakeFetch(() => json(messageBody()));
    const error: unknown = await createClaudeScreener({ apiKey: API_KEY, fetchFn: other.fetchFn })
      .screen(haiku)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unexpected_model", retryable: false, costMicroUsd: 690 });
  });

  it("refuses an answer from any other model as unexpected_model, never retried", async () => {
    const { fetchFn } = fakeFetch(() => json(messageBody({ model: "claude-opus-4-8" })));
    expect(await screenError(fetchFn)).toMatchObject({ code: "unexpected_model", retryable: false, usage: { inputTokens: 2400 } });
  });

  it.each([
    [400, "request_rejected", false],
    [404, "request_rejected", false],
    [413, "request_rejected", false],
    [401, "auth_failed", false],
    [403, "auth_failed", false],
    [500, "provider_unavailable", true],
    [502, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [504, "provider_unavailable", true],
    [529, "provider_unavailable", true],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    const { fetchFn } = fakeFetch(() => json({ type: "error", error: { type: "some_error", message: "details" } }, status));
    expect(await screenError(fetchFn)).toMatchObject({ code, status, retryable, usage: null, costMicroUsd: null });
  });

  it("maps HTTP 429 to rate_limited and carries retry-after in seconds", async () => {
    const limited = (headers: Record<string, string>) => fakeFetch(() => json({ type: "error" }, 429, headers)).fetchFn;
    expect(await screenError(limited({ "retry-after": "17" }))).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryable: true,
      retryAfterSeconds: 17,
    });
    expect(await screenError(limited({}))).toMatchObject({ code: "rate_limited", retryAfterSeconds: null });
    expect(await screenError(limited({ "retry-after": "soon" }))).toMatchObject({ retryAfterSeconds: null });
  });

  it("ends a hung request at the timeout as timeout, retried once, with no usage", async () => {
    // Like real fetch, the hung request only ends when its signal aborts.
    const hung: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      });
    expect(await screenError(hung, 20)).toMatchObject({ code: "timeout", status: null, retryable: true, usage: null });
  });

  it("maps a network error to provider_unavailable, retried once, and drops the original error", async () => {
    const failing: FetchFn = () => Promise.reject(new TypeError(`fetch failed for key ${API_KEY}`));
    const error = await screenError(failing);
    expect(error).toMatchObject({ code: "provider_unavailable", status: null, retryable: true, usage: null });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(API_KEY);
  });

  it("maps a 200 response that is not a message to schema_invalid without usage", async () => {
    const notJson = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 })).fetchFn;
    expect(await screenError(notJson)).toMatchObject({ code: "schema_invalid", status: 200, usage: null });
    const noUsage = fakeFetch(() => json({ ...messageBody(), usage: undefined })).fetchFn;
    expect(await screenError(noUsage)).toMatchObject({ code: "schema_invalid", status: 200, usage: null });
  });

  it("maps a response body that stalls until the timeout to timeout", async () => {
    // Headers arrive, the body never does; like real fetch, the stream errors when the signal aborts.
    const stalled: FetchFn = async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "TimeoutError")));
        },
      });
      return new Response(body, { status: 200 });
    };
    expect(await screenError(stalled, 20)).toMatchObject({ code: "timeout", status: null, usage: null });
  });

  it("maps an abort by the job's deadline signal to timeout", async () => {
    const hung: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const deadline = new AbortController();
    const pending = createClaudeScreener({ apiKey: API_KEY, fetchFn: hung }).screen(CALL, deadline.signal);
    deadline.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout", status: null });
  });

  it("keeps the key and the response body out of the error of a 401 whose body echoes the key", async () => {
    const echoed = `invalid x-api-key: ${API_KEY} BODY_SENTINEL_0e2b`;
    const { fetchFn } = fakeFetch(() => json({ type: "error", error: { type: "authentication_error", message: echoed } }, 401));
    const error = await screenError(fetchFn);
    expect(error.code).toBe("auth_failed");
    const forms = [error.message, String(error.stack), JSON.stringify(error), String(error), JSON.stringify(error.cause ?? null)];
    for (const form of forms) {
      expect(form).not.toContain(API_KEY);
      expect(form).not.toContain("SENTINEL_KEY");
      expect(form).not.toContain("BODY_SENTINEL");
    }
    expect(error.cause).toBeUndefined();
  });

  it("sends no item ID, URL or seller username in the request body built from a listing that carries them", async () => {
    const source = {
      title: "Espressomaschine Siebträger Dualboiler",
      condition: "Gebraucht",
      conditionDescription: null,
      priceCents: 125_000,
      shippingCents: 0,
      ownerMaxCents: 128_000,
      seller: { feedbackScore: 1200, feedbackPercent: 99.8, accountType: "business" as const, username: "SENTINEL_SELLER_7f3a" },
      returns: { accepted: true, periodDays: 30 },
      itemLocationCountry: "DE",
      itemCreationAt: null,
      itemSpecifics: [],
      imageCount: 4,
      descriptionText: "Mit Rechnung und ausgewiesener MwSt.",
      ruleFlags: [],
      codeSignals: [],
      itemId: "v1|SENTINEL_ITEM_8c1d|0",
      legacyItemId: "SENTINEL_LEGACY_8c1d",
      itemWebUrl: "https://www.ebay.de/itm/SENTINEL_LEGACY_8c1d",
      image: { imageUrl: "https://i.ebayimg.com/SENTINEL_IMAGE.jpg" },
    };
    const { fetchFn, calls } = fakeFetch(() => json(messageBody()));
    const product = {
      name: "Espresso machine",
      description: "A dual-boiler espresso machine.",
      must_contain: [["espresso", "espressomaschine"]],
      must_not_contain: [],
      conditions: ["used" as const],
      limit_eur: 1280,
    };
    const { userMessage } = buildScreeningRequest(product, source, new Date("2026-10-21T12:00:00.000Z"));
    await createClaudeScreener({ apiKey: API_KEY, fetchFn }).screen({ ...CALL, userMessage });
    const body = String(calls[0]?.init.body);
    expect(body).toContain("Espressomaschine Siebträger Dualboiler");
    for (const sentinel of ["SENTINEL_SELLER", "SENTINEL_ITEM", "SENTINEL_LEGACY", "SENTINEL_IMAGE", "https://", API_KEY]) {
      expect(body).not.toContain(sentinel);
    }
  });
});

async function screenError(fetchFn: FetchFn, timeoutMs?: number): Promise<ClaudeError> {
  const error: unknown = await createClaudeScreener({ apiKey: API_KEY, fetchFn, timeoutMs })
    .screen(CALL)
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(error).toBeInstanceOf(ClaudeError);
  return error as ClaudeError;
}
