import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, loadEnv, parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("reads a postgres DATABASE_URL", () => {
    expect(parseEnv({ DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper" })).toEqual({
      databaseUrl: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
    });
  });

  it.each([undefined, "", "http://ebay_sniper:sentinel-pw@postgres:5432/ebay_sniper", "not a url sentinel-pw"])(
    "refuses DATABASE_URL %s with an EnvError that names the variable, not the value",
    (value) => {
      let error: unknown;
      try {
        parseEnv({ DATABASE_URL: value });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).message).toContain("DATABASE_URL");
      expect(JSON.stringify(error)).not.toContain("sentinel-pw");
      expect(String((error as EnvError).message)).not.toContain("sentinel-pw");
    },
  );
});

describe("loadEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the process environment", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper");

    expect(loadEnv().databaseUrl).toBe("postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper");
  });
});
