import { berlinDay, collapseWhitespace, formatBerlinTime, removeHiddenCharacters } from "@ebay-sniper/domain";

// Spec 7.9, ADR 0038: the mail web sends to the active admins and the person concerned when
// something changes who can sign in or who gets alerts.

type Role = "admin" | "editor";

// The events of spec 7.9, plus the two sign-in limits that tell the admins (spec 7.5).
export type SecurityEvent =
  | { kind: "user_added"; email: string; role: Role }
  | { kind: "user_role_changed"; email: string; role: Role }
  | { kind: "user_disabled"; email: string }
  | { kind: "bootstrap_admin_added"; email: string }
  | { kind: "login_code_cli"; email: string; ref: string }
  // `added`: the people other than the editor who now get the product's alerts.
  | { kind: "recipients_changed"; product: string; added: readonly string[] }
  | { kind: "new_device_sign_in"; email: string }
  | { kind: "sign_in_locked"; email: string }
  | { kind: "login_mail_cap" };

export type SecurityMailInput = {
  event: SecurityEvent;
  // The person who did it, or "the ops CLI on the server" and the like.
  who: string;
  at: Date;
  // The IP shortened to /24, or null when none was recorded.
  ip24: string | null;
};

export type SecurityMail = { subject: string; text: string; html: string };

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

function whatHappened(event: SecurityEvent): string {
  switch (event.kind) {
    case "user_added":
      return `${event.email} was added as ${event.role}`;
    case "user_role_changed":
      return `${event.email} is now ${event.role}`;
    case "user_disabled":
      return `${event.email} was disabled`;
    case "bootstrap_admin_added":
      return `${event.email} was added as the first admin`;
    case "login_code_cli":
      return `a sign-in code for ${event.email} was given out on the server`;
    case "recipients_changed":
      return `${event.added.join(", ")} now ${event.added.length === 1 ? "gets" : "get"} the alerts of ${event.product}`;
    case "new_device_sign_in":
      return `${event.email} signed in from a new browser`;
    case "sign_in_locked":
      return `sign-in for ${event.email} is locked for new browsers`;
    case "login_mail_cap":
      return "the daily limit of sign-in mails is reached";
  }
}

export function renderSecurityMail(input: SecurityMailInput): SecurityMail {
  // A product name is typed by a person: one line, no hidden characters, before it reaches the
  // subject header or the HTML.
  const what = collapseWhitespace(removeHiddenCharacters(whatHappened(input.event)));
  const lines = [
    `What: ${what}`,
    `Who: ${input.who}`,
    `When: ${formatBerlinTime(input.at)} on ${berlinDay(input.at)}`,
    `IP: ${input.ip24 ?? "not recorded"}`,
  ];
  const advice = "If you did not expect this, sign in and check People and Activity, or use ops auth on the server.";
  return {
    subject: `Just-Buy-It: ${what}`,
    text: `${lines.join("\n")}\n\n${advice}\n`,
    html: `<p>${lines.map(escapeHtml).join("<br>")}</p><p>${escapeHtml(advice)}</p>`,
  };
}
