// The only place ops reads the system time (ADR 0008). Everything else gets this injected.
export const systemClock = { now: () => new Date() };
