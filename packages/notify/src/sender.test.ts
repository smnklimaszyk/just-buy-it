import { describe, expect, it } from "vitest";
import { SenderError } from "./errors.js";
import { parseSender } from "./sender.js";

describe("parseSender", () => {
  it("reads a display name with the address", () => {
    expect(parseSender("Just-Buy-It <info@intra-ai.de>")).toEqual({ name: "Just-Buy-It", address: "info@intra-ai.de" });
  });

  it("reads a display name in double quotes", () => {
    expect(parseSender('"Just-Buy-It" <info@intra-ai.de>')).toEqual({ name: "Just-Buy-It", address: "info@intra-ai.de" });
  });

  it("reads a bare address with an empty name", () => {
    expect(parseSender("info@intra-ai.de")).toEqual({ name: "", address: "info@intra-ai.de" });
  });

  it("rejects CR or LF in the name", () => {
    expect(() => parseSender("Just\r\nBcc: x@example.com <info@intra-ai.de>")).toThrow(SenderError);
  });

  it("rejects < or > inside the name", () => {
    expect(() => parseSender("Just <Buy <info@intra-ai.de>")).toThrow(SenderError);
    expect(() => parseSender('"Just > Buy" <info@intra-ai.de>')).toThrow(SenderError);
  });

  it("rejects an empty address", () => {
    expect(() => parseSender("Just-Buy-It <>")).toThrow(SenderError);
    expect(() => parseSender("Just-Buy-It < >")).toThrow(SenderError);
    expect(() => parseSender("")).toThrow(SenderError);
    expect(() => parseSender("   ")).toThrow(SenderError);
  });

  it("rejects a second address", () => {
    expect(() => parseSender("info@intra-ai.de, ops@intra-ai.de")).toThrow(SenderError);
    expect(() => parseSender("info@intra-ai.de;ops@intra-ai.de")).toThrow(SenderError);
    expect(() => parseSender("info@intra-ai.de ops@intra-ai.de")).toThrow(SenderError);
    expect(() => parseSender("A <info@intra-ai.de>, B <ops@intra-ai.de>")).toThrow(SenderError);
    expect(() => parseSender("Just-Buy-It <info@intra-ai.de> ops@intra-ai.de")).toThrow(SenderError);
    expect(() => parseSender("ops@intra-ai.de <info@intra-ai.de>")).toThrow(SenderError);
    expect(() => parseSender("Just-Buy-It <info@intra-ai.de,ops@intra-ai.de>")).toThrow(SenderError);
  });

  it("keeps a comma inside a quoted name", () => {
    expect(parseSender('"Intra AI, Alerts" <info@intra-ai.de>')).toEqual({
      name: "Intra AI, Alerts",
      address: "info@intra-ai.de",
    });
  });

  it("names the variable and the problem but never the value", () => {
    const parse = (): unknown => parseSender("Hidden\nName <hidden@intra-ai.de>");
    expect(parse).toThrow(/^ALERT_FROM /);
    expect(parse).toThrow(expect.objectContaining({ message: expect.not.stringMatching(/Hidden|hidden@/) }));
  });
});
