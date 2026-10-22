import { MODEL, type FetchFn } from "@ebay-sniper/llm";
import { hang, json, type Responder } from "./ebay.js";

// A fake Anthropic Messages API for the worker tests: the real Claude adapter runs on its fetchFn.

// Not a real key; the sentinel tests look for it in logs and errors.
export const CLAUDE_TEST_KEY = "sk-ant-test-SENTINEL-KEY-9c41";

export type FakeAnswer = {
  verdict: string;
  product_match: string;
  risk_flags: string[];
  reason: string;
};

export const PASS_ANSWER: FakeAnswer = {
  verdict: "pass",
  product_match: "match",
  risk_flags: [],
  reason: "The listing matches the segment; nothing beyond normal used-market risk.",
};

export type MessageOptions = {
  model?: string;
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

// A Messages API response body whose last text block holds the answer as JSON.
export function claudeMessage(answer: FakeAnswer | string, options: MessageOptions = {}): Record<string, unknown> {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: options.model ?? MODEL,
    stop_reason: options.stopReason ?? "end_turn",
    content: [
      { type: "thinking", thinking: "", signature: "fake" },
      { type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) },
    ],
    usage: { ...(options.usage ?? { input_tokens: 2000, output_tokens: 800 }), inference_geo: "global" },
  };
}

export type FakeClaudeRequest = { headers: Record<string, string>; body: Record<string, unknown> };

export function createFakeClaude() {
  const requests: FakeClaudeRequest[] = [];
  const responders: Responder[] = [];

  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/v1/messages") throw new Error(`unexpected fake Claude request: ${url.pathname}`);
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    requests.push({
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof body === "object" && body !== null ? { ...body } : {},
    });
    const responder = responders.shift();
    return responder ? responder(url, init?.signal) : json(claudeMessage(PASS_ANSWER));
  };

  return {
    fetchFn,
    requests,
    // The next calls get these answers, in order; after them, a pass.
    answer(...answers: (FakeAnswer | string)[]) {
      for (const answer of answers) responders.push(() => json(claudeMessage(answer)));
    },
    message(body: Record<string, unknown>) {
      responders.push(() => json(body));
    },
    // An HTTP error. The body may echo the request, as Anthropic's can.
    status(status: number, body: unknown = { type: "error" }, headers: Record<string, string> = {}) {
      responders.push(() => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
    },
    // Never answers; rejects when the adapter's timeout or the job's deadline aborts.
    hang() {
      responders.push((_url, signal) => hang(signal));
    },
  };
}
