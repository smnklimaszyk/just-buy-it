import { SenderError } from "./errors.js";

// The From of every alert email. Passed to nodemailer as an object, so nodemailer encodes the name.
export type Sender = { name: string; address: string };

const NAME_WITH_ADDRESS = /^(.*)<([^<>]*)>$/s;
const QUOTED = /^"(.*)"$/s;
const LINE_BREAK = /[\r\n]/;
const ANGLE_BRACKET = /[<>]/;
// One address: a local part and a domain, with nothing that could start a second address or a
// comment (space, comma, semicolon, brackets, quotes).
const ONE_ADDRESS = /^[^\s@<>",;()[\]\\]+@[^\s@<>",;()[\]\\]+$/;
// Outside quotes a comma or semicolon separates addresses.
const LIST_SEPARATOR = /[,;]/;

function checkedAddress(address: string): string {
  if (address === "") throw new SenderError("has an empty address");
  if (!ONE_ADDRESS.test(address)) throw new SenderError("is not exactly one email address");
  return address;
}

// ALERT_FROM (section 6.5): a bare address, or a display name with the address in angle brackets,
// the name optionally in double quotes. Read once at startup; a bad value stops the worker.
export function parseSender(value: string): Sender {
  const trimmed = value.trim();
  const match = NAME_WITH_ADDRESS.exec(trimmed);
  if (match === null) return { name: "", address: checkedAddress(trimmed) };
  const rawName = (match[1] ?? "").trim();
  const quoted = QUOTED.exec(rawName);
  const name = quoted?.[1] ?? rawName;
  if (LINE_BREAK.test(name)) throw new SenderError("has a line break in the display name");
  if (ANGLE_BRACKET.test(name)) throw new SenderError("has < or > in the display name");
  if (name.includes("@")) throw new SenderError("has an address in the display name");
  if (quoted === null && LIST_SEPARATOR.test(name)) throw new SenderError("has a second address");
  return { name, address: checkedAddress((match[2] ?? "").trim()) };
}
