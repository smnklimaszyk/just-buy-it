import { createSmtpMailer, type SmtpConfig } from "@ebay-sniper/notify";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../app.js";
import { createAuthKeys } from "../auth/keys.js";
import { createBackground } from "../background.js";
import type { AppEnv } from "../session.js";
import { CLIENT_SCRIPTS, type AssetManifest, type ClientScript } from "../ui/assets.js";
import { createTestDatabase } from "./database.js";
import { createFakeSmtp, createTestClock, createTestLog, LOGIN_SMTP_TEST_PASSWORD } from "./fakes.js";

// Test helper, not built: the web app on a test database, a hand-moved clock, a fake SMTP server
// and browsers that keep their cookies.

export const PUBLIC_ORIGIN = "https://deals.example.test";
// 12:00 in Berlin.
export const START = new Date("2026-10-21T10:00:00.000Z");
export const TEST_AUTH_KEY = Buffer.alloc(32, 11);

export const TEST_ASSETS: AssetManifest = {
  styles: "/assets/styles.0123456789ab.css",
  fonts: {
    geist: "/assets/Geist-Variable.0123456789ab.woff2",
    geistItalic: "/assets/Geist-Italic-Variable.0123456789ab.woff2",
    geistMono: "/assets/GeistMono-Variable.0123456789ab.woff2",
  },
  scripts: Object.fromEntries(CLIENT_SCRIPTS.map((s) => [s, `/assets/${s}.0123456789ab.js`])) as Record<ClientScript, string>,
};

export const LOGIN_SMTP: SmtpConfig = {
  host: "smtp.test",
  port: 587,
  user: "noreply@intra-ai.de",
  password: LOGIN_SMTP_TEST_PASSWORD,
  from: { name: "Just-Buy-It", address: "noreply@intra-ai.de" },
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(options: { smtp?: boolean } = {}) {
  const db = await createTestDatabase();
  const clock = createTestClock(START);
  const smtp = createFakeSmtp();
  const testLog = createTestLog();
  const background = createBackground(testLog.log);
  const deps: AppDeps = {
    pool: db.pool,
    clock,
    keys: createAuthKeys(TEST_AUTH_KEY),
    publicOrigin: PUBLIC_ORIGIN,
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    assets: TEST_ASSETS,
    assetFile: async (path) => (path === TEST_ASSETS.styles ? new TextEncoder().encode(":root{}") : null),
    log: testLog.log,
    background,
    mail: options.smtp === false ? null : { mailer: createSmtpMailer(LOGIN_SMTP, smtp.createTransport), from: LOGIN_SMTP.from.address },
    settingsEnv: { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null },
    alertTo: "alerts@example.test",
    // Two pairs passed; Sonnet low and high and Opus did not.
    screeningOptions: [
      { model: "claude-sonnet-5-5", effort: "medium", passedOn: "2026-10-20", worstCaseMicrousd: 67_000 },
      { model: "claude-haiku-5-5", effort: "medium", passedOn: "2026-10-20", worstCaseMicrousd: 3_350 },
    ],
  };
  const app = createApp(deps);
  // A handler that throws fails the test with its own error instead of a bare 500.
  app.onError((error) => {
    throw error;
  });
  return {
    db,
    clock,
    smtp,
    testLog,
    background,
    deps,
    app,
    browser: (ip = "198.51.100.7") => createBrowser(app, ip),
  };
}

export type Browser = ReturnType<typeof createBrowser>;

type Form = Record<string, string | string[]>;

// Keeps the cookies a real browser would, and sends what a same-origin form post sends.
export function createBrowser(app: Hono<AppEnv>, ip: string) {
  const cookies = new Map<string, string>();
  const store = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const maxAge = /;\s*Max-Age=(\d+)/i.exec(line)?.[1];
      if (maxAge === "0") cookies.delete(name);
      else cookies.set(name, pair.slice(at + 1));
    }
    return response;
  };
  const headers = (extra: Record<string, string>): Record<string, string> => ({
    "X-Forwarded-For": ip,
    "Sec-Fetch-Site": "same-origin",
    ...(cookies.size === 0 ? {} : { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }),
    ...extra,
  });
  const body = (form: Form) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
    return params.toString();
  };
  return {
    cookies,
    get: async (path: string, extra: Record<string, string> = {}) => store(await app.request(path, { headers: headers(extra) })),
    post: async (path: string, form: Form, extra: Record<string, string> = {}) =>
      store(
        await app.request(path, {
          method: "POST",
          headers: headers({ "Content-Type": "application/x-www-form-urlencoded", ...extra }),
          body: body(form),
        }),
      ),
  };
}

// The hidden form token of a page.
export function formToken(html: string): string {
  const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (token === undefined) throw new Error("the page has no _csrf field");
  return token;
}

export async function addPerson(h: Harness, email: string, role: "admin" | "editor", status: "active" | "disabled" = "active"): Promise<string> {
  const result = await h.db.admin.query<{ id: string }>(
    `INSERT INTO auth.app_user (email, role, status, created_at, disabled_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'disabled' THEN $4::timestamptz END) RETURNING id`,
    [email, role, status, h.clock.now()],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no person added");
  return id;
}

// The whole sign-in in one browser: address, mail, code. The person must exist and be active.
export async function signIn(h: Harness, browser: Browser, email: string): Promise<void> {
  const token = formToken(await (await browser.get("/login")).text());
  await browser.post("/login", { _csrf: token, email });
  await h.background.settled();
  const mail = h.smtp.sent.filter((sent) => sent.to === email).at(-1);
  const code = /sign-in code: (\d{4}) (\d{4})/.exec(String(mail?.text));
  if (code === null) throw new Error(`no sign-in mail to ${email}`);
  const codeToken = formToken(await (await browser.get("/login/code")).text());
  const response = await browser.post("/login/code", { _csrf: codeToken, code: `${code[1]}${code[2]}` });
  if (response.headers.get("location") !== "/") throw new Error(`sign-in of ${email} failed`);
}
