import { describe, expect, it } from "vitest";
import { createBackground } from "./background.js";
import { createTestLog } from "./testing/fakes.js";

describe("createBackground", () => {
  it("runs the work without the caller waiting, and settled() waits for it and for work it starts", async () => {
    const { log } = createTestLog();
    const background = createBackground(log);
    const done: string[] = [];
    let release: () => void = () => undefined;

    background.run(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      done.push("first");
      background.run(async () => {
        done.push("second");
      });
    });
    expect(done).toEqual([]);

    const settled = background.settled().then(() => done.push("settled"));
    release();
    await settled;
    expect(done).toEqual(["first", "second", "settled"]);
  });

  it("logs a failed piece of work by the error's name only, since a message can carry an address", async () => {
    const testLog = createTestLog();
    const background = createBackground(testLog.log);

    background.run(async () => {
      throw new TypeError("no person anna@example.test");
    });
    await background.settled();

    expect(testLog.lines).toEqual([{ level: "error", entry: { event: "background_failed", err_name: "TypeError" } }]);
  });
});
