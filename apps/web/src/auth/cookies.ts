import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

// Every cookie of web is a __Host- cookie (spec 7.2, 7.4, 7.5, 7.11): Secure, Path=/, no Domain,
// so no other *.intra-ai.de app can set or read it. hono/cookie refuses a __Host- cookie that
// breaks these rules.

const LOGIN = "jbi_login";

// Spec 7.2: binds the form token and the code to the browser that asked, for 10 minutes.
export function setLoginCookie(c: Context, value: string): void {
  setCookie(c, LOGIN, value, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Strict", maxAge: 600 });
}

// Only the __Host- form: a cookie without the prefix could come from another *.intra-ai.de site.
export const loginCookie = (c: Context): string | undefined => getCookie(c, LOGIN, "host");

export function clearLoginCookie(c: Context): void {
  setCookie(c, LOGIN, "", { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Strict", maxAge: 0 });
}

export const sessionCookie = (c: Context): string | undefined => getCookie(c, "jbi_session", "host");

// Spec 7.4: 7 days, never extended. Lax, so a link from a mail opens the signed-in page.
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, "jbi_session", token, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 604_800 });
}

export function clearSessionCookie(c: Context): void {
  setCookie(c, "jbi_session", "", { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 0 });
}

export const deviceCookie = (c: Context): string | undefined => getCookie(c, "jbi_device", "host");

// Spec 7.11: the chosen theme for a year; readers accept only "light" or "dark".
export function setThemeCookie(c: Context, theme: "light" | "dark"): void {
  setCookie(c, "jbi_theme", theme, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 31_536_000 });
}

export const themeCookie = (c: Context): "light" | "dark" => (getCookie(c, "jbi_theme", "host") === "dark" ? "dark" : "light");

// Spec 7.5: 180 days, set or refreshed on every sign-in.
export function setDeviceCookie(c: Context, token: string): void {
  setCookie(c, "jbi_device", token, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 15_552_000 });
}
