import type { Clock } from "@ebay-sniper/domain";

// A clock the test moves by hand (ADR 0008).
export type TestClock = Clock & { set(at: Date): void; advance(ms: number): void };

export function createTestClock(start: Date): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set(at) {
      current = at.getTime();
    },
    advance(ms) {
      current += ms;
    },
  };
}
