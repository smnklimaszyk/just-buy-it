// The product form's cost box. Without script, "Check cost" posts the form and the page comes
// back with the preview. With script, the form is posted in the background to its
// data-cost-preview URL after each change and the reply fills the box in place.

/** What the preview URL answers (spec 5.3: the preview line, room left, the cheapest fix). */
export interface CostReply {
  tone: "info" | "danger";
  lines: string[];
  /** The plan after the save against the ceiling, for the Meter in the box. */
  meter?: { value: number; max: number };
}

/** Same thresholds and number format as Meter in ui/feedback.tsx. */
function showMeter(box: Element, value: number, max: number): void {
  const meter = box.querySelector(".ia-meter");
  if (!meter) return;
  const r = Math.min(value / max, 1);
  const tone = r >= 0.95 ? "danger" : r >= 0.8 ? "warning" : "neutral";
  meter.className = `ia-meter ia-meter--${tone}`;
  const label = meter.querySelector(".ia-meter__val");
  if (label) label.textContent = `${value.toLocaleString("en-GB")} / ${max.toLocaleString("en-GB")}`;
  meter.querySelector("meter")?.setAttribute("value", String(value));
  meter.querySelector(".ia-meter__fill rect")?.setAttribute("width", `${Number((r * 100).toFixed(2))}%`);
}

const QUIET_MS = 600;

function isCostReply(value: unknown): value is CostReply {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const m = v["meter"] as { value?: unknown; max?: unknown } | undefined;
  if (m !== undefined && (typeof m.value !== "number" || typeof m.max !== "number" || m.max <= 0)) return false;
  return (v["tone"] === "info" || v["tone"] === "danger") && Array.isArray(v["lines"]) && v["lines"].every((l) => typeof l === "string");
}

/** Fills the Callout with the reply, as text only. */
function show(box: Element, reply: CostReply): void {
  const callout = box.querySelector(".ia-callout");
  const body = box.querySelector(".ia-callout__body");
  if (!callout || !body) return;
  callout.className = `ia-callout ia-callout--${reply.tone}`;
  if (reply.meter) showMeter(box, reply.meter.value, reply.meter.max);
  body.replaceChildren(
    ...reply.lines.map((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      return p;
    }),
  );
}

export function enhanceCostPreview(root: ParentNode): void {
  for (const form of root.querySelectorAll<HTMLFormElement>("form[data-cost-preview]")) {
    const url = form.dataset["costPreview"];
    const box = form.querySelector("[data-cost-result]");
    if (!url || !box) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = 0;
    /** True when the box shows a fresh reply. */
    const preview = async (): Promise<boolean> => {
      const data = new FormData(form);
      const asked = ++latest;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { Accept: "application/json", "X-CSRF-Token": String(data.get("_csrf")) },
          body: new URLSearchParams([...data].map(([k, v]) => [k, String(v)])),
        });
        if (!response.ok) return false;
        const reply: unknown = await response.json();
        if (!isCostReply(reply)) return false;
        // A later change has asked again; its reply is the one to show.
        if (asked !== latest) return true;
        show(box, reply);
        return true;
      } catch {
        return false;
      }
    };
    let plainPost = false;
    form.addEventListener("submit", (e) => {
      const button = e.submitter;
      if (plainPost || !(button instanceof HTMLButtonElement) || !button.hasAttribute("data-cost-check")) return;
      e.preventDefault();
      void preview().then((shown) => {
        if (shown) return;
        // The server renders the preview itself on the plain post.
        plainPost = true;
        form.requestSubmit(button);
      });
    });
    form.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(preview, QUIET_MS);
    });
  }
}

if (typeof document !== "undefined") enhanceCostPreview(document);
