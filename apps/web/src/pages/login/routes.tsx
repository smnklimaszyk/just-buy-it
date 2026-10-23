import { allowLoginMail, checkLoginCode, openAttempt, rateLimitReached, startLoginAttempt, takeRateSlot } from "@ebay-sniper/db";
import { renderLoginMail } from "@ebay-sniper/notify";
import { Hono, type Context } from "hono";
import type { AppDeps } from "../../app.js";
import { normalizeAddress } from "../../auth/address.js";
import {
  clearLoginCookie,
  deviceCookie,
  loginCookie,
  sessionCookie,
  setDeviceCookie,
  setLoginCookie,
  setSessionCookie,
  themeCookie,
} from "../../auth/cookies.js";
import { clientIp, rateLimitIp } from "../../auth/ip.js";
import type { Outbox } from "../../auth/security-mail.js";
import { newCode, newToken, sameSecret, tokenHash } from "../../auth/tokens.js";
import type { AppEnv } from "../../session.js";
import { codePage, loginPage } from "./views.js";

const field = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  return typeof value === "string" ? value : "";
};

// GET/POST /login and /login/code (spec 7.2), the public part of web. `outbox` is null when no
// sign-in mailbox is set: then only `ops auth code` signs people in.
export function loginRoutes(deps: AppDeps, outbox: Outbox | null): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // The code page with the one failure message, and the reference while the attempt is open.
  const failedCodePage = async (c: Context<AppEnv>, login: string): Promise<string> => {
    const attempt = await openAttempt(deps.pool, tokenHash(login), deps.clock.now());
    return codePage({ assets: deps.assets, theme: themeCookie(c), formToken: deps.keys.loginFormToken(login), ref: attempt?.ref ?? null, failed: true });
  };

  routes.get("/", (c) => {
    // A browser that already holds a login cookie keeps it: its own /favicon.ico request is sent
    // here too, and a new cookie would break the form the person has open.
    const login = loginCookie(c) ?? newToken();
    setLoginCookie(c, login);
    return c.html(loginPage({ assets: deps.assets, theme: themeCookie(c), formToken: deps.keys.loginFormToken(login) }));
  });

  // Spec 7.2: the same steps and the same reply for every address; the mail goes out after the
  // reply, and only to an active person within the caps.
  routes.post("/", async (c) => {
    const body = await c.req.parseBody();
    const login = loginCookie(c);
    if (login === undefined || !sameSecret(field(body, "_csrf"), deps.keys.loginFormToken(login))) return c.redirect("/login", 303);
    const email = normalizeAddress(field(body, "email"));
    // Not an address at all: nothing about approval is told, so the form can say so.
    if (email === null) {
      return c.html(loginPage({ assets: deps.assets, theme: themeCookie(c), formToken: deps.keys.loginFormToken(login), email: field(body, "email").slice(0, 254), invalid: true }), 400);
    }
    const at = deps.clock.now();
    const ip = clientIp(c.req.header("x-forwarded-for"));
    const next = newToken();
    const code = newCode();
    const device = deviceCookie(c);
    const started = await startLoginAttempt(deps.pool, {
      at,
      email,
      emailMac: deps.keys.emailMac(email),
      ipMac: deps.keys.ipMac(rateLimitIp(ip)),
      ip,
      userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
      attemptHash: tokenHash(next),
      // Spec 7.5: a browser that signed in before uses its own counters, so a stranger's guessing
      // cannot lock it out.
      deviceTokenHash: device === undefined ? null : deps.keys.deviceHash(device),
      codeMac: (attemptId) => deps.keys.codeMac(attemptId, code),
    });
    setLoginCookie(c, next);
    if (started.ok && outbox !== null) {
      deps.background.run(async () => {
        const decision = await allowLoginMail(deps.pool, { attemptId: started.attemptId, at });
        if (decision.send) {
          outbox.queue.push({
            id: started.attemptId,
            to: decision.email,
            mail: renderLoginMail({ code, ref: decision.ref, expiresAt: decision.expiresAt }),
          });
          return;
        }
        // Spec 7.5: after 10 failed tries new browsers get no code; the admins hear of it at most
        // once an hour.
        if (decision.reason === "locked" && decision.notifyAdmins) {
          await outbox.security.send({ kind: "sign_in_locked", email }, { at, who: "the sign-in lockout", ip, concerned: [] });
          return;
        }
        // auth.md 15: the 61st sign-in mail of the day is not sent, and the admins hear of it,
        // at most once an hour.
        if (
          decision.reason === "capped" &&
          (await rateLimitReached(deps.pool, "login_mails_day", "all", at)) &&
          (await takeRateSlot(deps.pool, "lockout_mail_hour", "login_mails_day", at))
        ) {
          await outbox.security.send({ kind: "login_mail_cap" }, { at, who: "the sign-in mail limit", ip: null, concerned: [] });
        }
      });
    }
    return c.redirect("/login/code", 303);
  });

  routes.get("/code", async (c) => {
    const login = loginCookie(c) ?? "";
    const attempt = await openAttempt(deps.pool, tokenHash(login), deps.clock.now());
    if (attempt === null) return c.redirect("/login", 303);
    return c.html(codePage({ assets: deps.assets, theme: themeCookie(c), formToken: deps.keys.loginFormToken(login), ref: attempt.ref }));
  });

  // Spec 7.2 and 7.3: on the right code a new session and a device cookie; the login cookie goes.
  routes.post("/code", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const login = loginCookie(c) ?? "";
    // Spec 7.2: the form token is tied to the login cookie. A mismatch uses no try.
    if (!sameSecret(field(body, "_csrf"), deps.keys.loginFormToken(login))) return c.html(await failedCodePage(c, login));
    const typed = [body["code"]].flat().filter((part) => typeof part === "string").join("").replace(/\s/g, "");
    const ip = clientIp(c.req.header("x-forwarded-for"));
    const sessionToken = newToken();
    const deviceToken = newToken();
    const previous = sessionCookie(c);
    const result = await checkLoginCode(deps.pool, {
      at: deps.clock.now(),
      attemptHash: tokenHash(login),
      ipMac: deps.keys.ipMac(rateLimitIp(ip)),
      ip,
      userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
      matches: (attempt) => sameSecret(deps.keys.codeMac(attempt.id, typed), attempt.codeMac),
      sessionTokenHash: tokenHash(sessionToken),
      csrfSecret: newToken(),
      // A new token on every sign-in: the session the browser came with ends (spec 7.4).
      previousSessionTokenHash: previous === undefined ? null : tokenHash(previous),
      newDeviceTokenHash: deps.keys.deviceHash(deviceToken),
    });
    if (!result.ok) return c.html(await failedCodePage(c, login));
    setSessionCookie(c, sessionToken);
    // Spec 7.5: a known device keeps its cookie for another 180 days; any other browser gets the
    // new device the sign-in just stored.
    setDeviceCookie(c, result.newDevice ? deviceToken : (deviceCookie(c) ?? deviceToken));
    clearLoginCookie(c);
    return c.redirect("/", 303);
  });

  return routes;
}
