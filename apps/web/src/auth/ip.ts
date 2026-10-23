import { isIP } from "node:net";

// Spec 7.5: Traefik appends the peer address to X-Forwarded-For and drops what an outside client
// sent (to be confirmed by the proxy test on the host), so only the last entry counts. Used for
// the rate limits and the sign-in record only. null when there is none, as over the SSH tunnel.
export function clientIp(forwardedFor: string | undefined): string | null {
  const last = forwardedFor?.split(",").at(-1)?.trim() ?? "";
  return isIP(last) === 0 ? null : last;
}

// The eight groups of an IPv6 address, "::" filled in.
function ipv6Groups(ip: string): string[] {
  const [head = "", tail] = ip.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  return [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
}

// The client the IP rate limits count (spec 7.5): an IPv4 address, or the /64 of an IPv6 address,
// since one host can switch freely inside its /64.
export function rateLimitIp(ip: string | null): string {
  if (ip === null) return "none";
  return isIP(ip) === 4 ? ip : `${ipv6Groups(ip).slice(0, 4).join(":")}::/64`;
}

// What people see of an IP (spec 7.9, auth.md 9): the /24 of an IPv4 address, the /64 of IPv6.
export function shortIp(ip: string | null): string | null {
  if (ip === null) return null;
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  return `${ipv6Groups(ip).slice(0, 4).join(":")}::/64`;
}
