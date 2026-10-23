import { describe, expect, it } from "vitest";
import { clientIp, rateLimitIp, shortIp } from "./ip.js";

describe("clientIp (spec 7.5)", () => {
  it("takes the last X-Forwarded-For entry, the one Traefik wrote, and only a real IP", () => {
    expect(clientIp("198.51.100.7")).toBe("198.51.100.7");
    expect(clientIp("203.0.113.1, 10.0.0.1,198.51.100.7 ")).toBe("198.51.100.7");
    expect(clientIp("198.51.100.7, 2001:db8::1")).toBe("2001:db8::1");
    for (const bad of [undefined, "", "unknown", "198.51.100.7, not-an-ip", "198.51.100.7,", "1.2.3.4'); DROP"]) {
      expect(clientIp(bad)).toBeNull();
    }
  });
});

describe("rateLimitIp (spec 7.5)", () => {
  it("counts an IPv4 address on its own and every address of an IPv6 /64 as one client", () => {
    expect(rateLimitIp("198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitIp("2001:db8:1:2:3:4:5:6")).toBe(rateLimitIp("2001:db8:1:2:ffff::1"));
    expect(rateLimitIp("2001:db8:1:3::1")).not.toBe(rateLimitIp("2001:db8:1:2::1"));
    expect(rateLimitIp(null)).toBe("none");
  });
});

describe("shortIp", () => {
  it("shows an IPv4 address as its /24 and an IPv6 address as its /64, as the account page and security mails do", () => {
    expect(shortIp("198.51.100.7")).toBe("198.51.100.0/24");
    expect(shortIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(shortIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(shortIp(null)).toBeNull();
  });
});
