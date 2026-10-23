// A form that takes a moment shows the design system's button spinner after 300 ms
// (README: loading shows only after 300 ms) and refuses a second submit meanwhile.

const BUSY_AFTER_MS = 300;
const SVG = "http://www.w3.org/2000/svg";

function svgElement(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** The Spinner of ui/core.tsx, built with DOM calls. */
function spinner(size: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "ia-spinner";
  const svg = svgElement("svg", { viewBox: "0 0 16 16", width: String(size), height: String(size), "aria-hidden": "true" });
  const ring = { fill: "none", stroke: "currentColor", "stroke-width": "1.75" };
  svg.append(
    svgElement("circle", { cx: "8", cy: "8", r: "6.5", ...ring, "stroke-opacity": "0.25" }),
    svgElement("path", { d: "M14.5 8A6.5 6.5 0 0 0 8 1.5", ...ring, "stroke-linecap": "round" }),
  );
  wrap.append(svg);
  return wrap;
}

/** Shows the spinner and returns how to take it away again. */
function showBusy(button: HTMLButtonElement): () => void {
  button.setAttribute("aria-busy", "true");
  const size = button.classList.contains("ia-btn--lg") ? 18 : 16;
  const icon = button.firstElementChild;
  if (icon?.classList.contains("ia-icon")) {
    const spin = spinner(size);
    icon.replaceWith(spin);
    return () => {
      spin.replaceWith(icon);
      button.removeAttribute("aria-busy");
    };
  }
  const spin = document.createElement("span");
  spin.className = "ia-btn__spin";
  spin.append(spinner(size));
  button.classList.add("is-overlay-loading");
  button.append(spin);
  return () => {
    spin.remove();
    button.classList.remove("is-overlay-loading");
    button.removeAttribute("aria-busy");
  };
}

export function enhanceForms(root: ParentNode): void {
  for (const form of root.querySelectorAll("form")) {
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let undo: (() => void) | undefined;
    // Back from the next page through the back-forward cache: the form must work again.
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      sent = false;
      clearTimeout(timer);
      undo?.();
      undo = undefined;
    });
    form.addEventListener("submit", (e) => {
      if (sent) {
        e.preventDefault();
        return;
      }
      // Decide after every listener has run: a page script may take this submit over.
      queueMicrotask(() => {
        if (e.defaultPrevented) return;
        sent = true;
        const button = e.submitter instanceof HTMLButtonElement ? e.submitter : form.querySelector<HTMLButtonElement>("button[type=submit]");
        if (button) timer = setTimeout(() => (undo = showBusy(button)), BUSY_AFTER_MS);
      });
    });
  }
}

if (typeof document !== "undefined") enhanceForms(document);
