// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhanceCostPreview } from "./cost-preview.js";

// The product form's cost box: a Callout and a Meter as ui/feedback.tsx renders them.
const FORM = `<form method="post" action="/products/new" data-cost-preview="/products/cost-preview">
  <input type="hidden" name="_csrf" value="tok-1"/>
  <input id="name" name="name" value="Road bike"/>
  <div data-cost-result="">
    <aside class="ia-callout ia-callout--info"><svg class="ia-icon ia-callout__icon"></svg><div><p class="type-ui-strong ia-callout__title">Cost</p><div class="type-ui-body-sm ia-callout__body">Not checked yet.</div></div></aside>
  </div>
  <button id="check" type="submit" name="intent" value="check-cost" data-cost-check="">Check cost</button>
</form>`;

function mount() {
  document.body.innerHTML = FORM;
  enhanceCostPreview(document);
  const form = document.querySelector("form");
  const name = document.querySelector<HTMLInputElement>("#name");
  if (!form || !name) throw new Error("fixture missing");
  return { form, name, body: () => document.querySelector(".ia-callout__body")?.textContent, callout: () => document.querySelector(".ia-callout") };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cost-preview", () => {
  it("posts the form to the preview URL once, 600 ms after the last change", async () => {
    const fetchFn = vi.fn(async () => Response.json(REPLY));
    vi.stubGlobal("fetch", fetchFn);
    const { name } = mount();

    name.value = "Road bike 56";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(599);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/products/cost-preview");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("name=Road+bike+56");
  });

  it("sends the CSRF token as a header and shows the reply's lines and tone in the cost callout, as text", async () => {
    const fetchFn = vi.fn(async () => Response.json({ ...REPLY, lines: [...REPLY.lines, "<b>not markup</b>"] }));
    vi.stubGlobal("fetch", fetchFn);
    const { name, body, callout } = mount();

    name.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("tok-1");
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    await vi.waitFor(() => expect(callout()?.className).toBe("ia-callout ia-callout--danger"));
    expect(body()).toBe("2,541 calls a day, over the 2,500 limit.Choose slow speed to save 96 calls.<b>not markup</b>");
    expect(document.querySelector(".ia-callout__body b")).toBeNull();
  });

  it("answers Check cost in place at once, and falls back to the plain post with that button when the preview fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(REPLY)));
    const { form, callout } = mount();
    const check = document.querySelector<HTMLButtonElement>("#check");
    if (!check) throw new Error("fixture missing");

    const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: check });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(callout()?.className).toBe("ia-callout ia-callout--danger"));

    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));
    const plain = vi.spyOn(form, "requestSubmit").mockImplementation(() => undefined);
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: check }));
    await vi.waitFor(() => expect(plain).toHaveBeenCalledWith(check));
  });

  it("drops a reply that comes back after the reply to a later change", async () => {
    let releaseFirst: (r: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => (releaseFirst = resolve));
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => Response.json({ tone: "info", lines: ["204 calls a day."] }));
    vi.stubGlobal("fetch", fetchFn);
    const { name, body } = mount();

    name.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(body()).toBe("204 calls a day."));

    releaseFirst(Response.json(REPLY));
    await vi.advanceTimersByTimeAsync(0);
    expect(body()).toBe("204 calls a day.");
  });

  it("moves the plan Meter in the box to the reply's numbers, tone included", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...REPLY, meter: { value: 2400, max: 2500 } })));
    document.body.innerHTML = FORM.replace(
      `<div data-cost-result="">`,
      `<div data-cost-result=""><div class="ia-meter ia-meter--neutral"><div class="ia-meter__top"><span class="type-ui-label">Plan after save</span><span class="type-ui-body-sm ia-num ia-meter__val">1,000 / 2,500</span></div><meter min="0" max="2500" value="1000" class="ia-meter__bar"></meter><div class="ia-meter__track" aria-hidden="true"><svg class="ia-meter__fill"><rect width="40%" height="100%"></rect></svg></div></div>`,
    );
    enhanceCostPreview(document);

    document.querySelector("#name")?.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);

    await vi.waitFor(() => expect(document.querySelector(".ia-meter__val")?.textContent).toBe("2,400 / 2,500"));
    expect(document.querySelector(".ia-meter")?.className).toBe("ia-meter ia-meter--danger");
    expect(document.querySelector(".ia-meter__fill rect")?.getAttribute("width")).toBe("96%");
    expect(document.querySelector("meter")?.getAttribute("value")).toBe("2400");
  });

  it("keeps the box as it is when the reply is not a cost reply", async () => {
    const replies = [{ tone: "loud", lines: ["x"] }, { tone: "info", lines: [1] }, { tone: "info", lines: ["x"], meter: { value: "a", max: 2500 } }];
    for (const reply of replies) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(reply)));
      const { name, body } = mount();

      name.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(600);
      await vi.advanceTimersByTimeAsync(0);

      expect(body()).toBe("Not checked yet.");
    }
  });

  it("watches the product form as soon as the module loads", async () => {
    const fetchFn = vi.fn(async () => Response.json(REPLY));
    vi.stubGlobal("fetch", fetchFn);
    document.body.innerHTML = FORM;
    vi.resetModules();
    await import("./cost-preview.js");

    document.querySelector("#name")?.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);

    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

const REPLY = { tone: "danger", lines: ["2,541 calls a day, over the 2,500 limit.", "Choose slow speed to save 96 calls."] };
