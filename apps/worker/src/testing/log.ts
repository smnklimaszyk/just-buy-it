export type LogEntry = Record<string, unknown>;
export type LogLevel = "info" | "warn" | "error";

// Captures what the handlers log, in order, with the level.
export function createTestLog() {
  const lines: { level: LogLevel; entry: LogEntry }[] = [];
  const at = (level: LogLevel) => (entry: LogEntry) => {
    lines.push({ level, entry });
  };
  return {
    log: { info: at("info"), warn: at("warn"), error: at("error") },
    lines,
    // The entries of one event, in order.
    events(event: string): LogEntry[] {
      return lines.filter((line) => line.entry.event === event).map((line) => line.entry);
    },
    // Everything logged, as one string, for checks that a value never reaches the log.
    text(): string {
      return JSON.stringify(lines);
    },
  };
}
