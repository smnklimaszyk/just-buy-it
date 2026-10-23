// While a market snapshot runs, the product page's market box carries data-market-poll="<url>".
// This script asks that URL every 3 s and reloads the page once the check is done. Without
// script the page refreshes itself every 5 s instead (a <noscript> meta refresh).

const EVERY_MS = 3000;
/** 2 minutes; a snapshot takes at most 3 pages of calls, so longer means it is stuck. */
const MAX_ASKS = 40;

function isDone(reply: unknown): boolean {
  return typeof reply === "object" && reply !== null && "checking" in reply && reply.checking === false;
}

export function pollMarket(root: ParentNode, reload: () => void): void {
  const box = root.querySelector<HTMLElement>("[data-market-poll]");
  const url = box?.dataset["marketPoll"];
  if (!url) return;
  let asks = 0;
  const ask = async () => {
    if (++asks > MAX_ASKS) return;
    try {
      // X-Auto-Refresh: the server does not count this as activity (the session stays idle).
      const response = await fetch(url, { headers: { "X-Auto-Refresh": "1", Accept: "application/json" } });
      if (!response.ok) return;
      if (isDone(await response.json())) reload();
      else setTimeout(ask, EVERY_MS);
    } catch {
      // Offline or not JSON (a sign-in page after the session ended): leave the page as it is.
    }
  };
  setTimeout(ask, EVERY_MS);
}

if (typeof document !== "undefined") pollMarket(document, () => location.reload());
