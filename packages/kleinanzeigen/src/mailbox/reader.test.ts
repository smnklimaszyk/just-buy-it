import { readdirSync, readFileSync } from "node:fs";
import { inspect } from "node:util";
import type { ImapFlowOptions } from "imapflow";
import { describe, expect, it, vi } from "vitest";
import { createFakeImapClient, type FakeMessage } from "../testing/fake-imap.js";
import { createMailboxReader, type MailboxReaderOptions } from "./reader.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;

function message(uid: number, ageMs: number, size = 60_000): FakeMessage {
  return { uid, internalDate: new Date(NOW.getTime() - ageMs), size, source: Buffer.from(`message ${uid}`) };
}

function readerOptions(fake: ReturnType<typeof createFakeImapClient>, extra: Partial<MailboxReaderOptions> = {}) {
  return {
    host: "imap.example.invalid",
    port: 993,
    user: "mailbox@example.invalid",
    password: "not-a-real-password",
    clock: { now: () => NOW },
    createClient: () => fake.client,
    ...extra,
  };
}

describe("createMailboxReader", () => {
  it("reads the last 24 hours when it has no state yet", async () => {
    const fake = createFakeImapClient({
      uidValidity: 7n,
      uidNext: 13,
      messages: [message(10, 24 * HOUR + 1_000), message(11, 23 * HOUR + 59 * 60_000), message(12, HOUR)],
    });
    const result = await createMailboxReader(readerOptions(fake)).fetchNew(null);
    expect(result).toEqual({
      state: { uidValidity: "7", lastUid: 12 },
      hasMore: false,
      messages: [
        { uid: 11, internalDate: new Date(NOW.getTime() - 23 * HOUR - 59 * 60_000), size: 60_000, raw: Buffer.from("message 11") },
        { uid: 12, internalDate: new Date(NOW.getTime() - HOUR), size: 60_000, raw: Buffer.from("message 12") },
      ],
    });
  });

  it("continues after the stored uid when the uidValidity is unchanged, whatever the message age", async () => {
    const fake = createFakeImapClient({
      uidValidity: 7n,
      uidNext: 16,
      messages: [message(12, 5 * HOUR), message(13, 3 * 24 * HOUR), message(15, HOUR)],
    });
    const result = await createMailboxReader(readerOptions(fake)).fetchNew({ uidValidity: "7", lastUid: 12 });
    expect(result.state).toEqual({ uidValidity: "7", lastUid: 15 });
    expect(result.messages.map((m) => m.uid)).toEqual([13, 15]);
    expect(fake.calls.find((call) => call.method === "search")?.args).toEqual([{ uid: "13:*" }, { uid: true }]);
  });

  it("returns nothing new when the server answers N:* with the highest uid below N", async () => {
    const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, messages: [message(12, HOUR)] });
    const result = await createMailboxReader(readerOptions(fake)).fetchNew({ uidValidity: "7", lastUid: 12 });
    expect(result).toEqual({ state: { uidValidity: "7", lastUid: 12 }, messages: [], hasMore: false });
  });

  it("falls back to the look-back when the uidValidity changed", async () => {
    const fake = createFakeImapClient({
      uidValidity: 8n,
      uidNext: 4,
      messages: [message(1, 3 * 24 * HOUR), message(2, 2 * HOUR), message(3, HOUR)],
    });
    const result = await createMailboxReader(readerOptions(fake)).fetchNew({ uidValidity: "7", lastUid: 500 });
    expect(result.state).toEqual({ uidValidity: "8", lastUid: 3 });
    expect(result.messages.map((m) => m.uid)).toEqual([2, 3]);
  });

  it("takes at most maxMessages, oldest first, and says more are waiting", async () => {
    const messages = [21, 22, 23, 24, 25].map((uid) => message(uid, HOUR));
    const reader = createMailboxReader(
      readerOptions(createFakeImapClient({ uidValidity: 7n, uidNext: 26, messages }), { maxMessages: 2 }),
    );
    const first = await reader.fetchNew({ uidValidity: "7", lastUid: 20 });
    expect([first.messages.map((m) => m.uid), first.state, first.hasMore]).toEqual([
      [21, 22],
      { uidValidity: "7", lastUid: 22 },
      true,
    ]);
    const second = await reader.fetchNew(first.state);
    const third = await reader.fetchNew(second.state);
    expect([second.messages.map((m) => m.uid), second.hasMore, third.messages.map((m) => m.uid), third.hasMore]).toEqual([
      [23, 24],
      true,
      [25],
      false,
    ]);
  });

  it("does not download a message over maxMessageBytes but still moves past it", async () => {
    const fake = createFakeImapClient({
      uidValidity: 7n,
      uidNext: 23,
      messages: [message(21, HOUR, 2_000_000), message(22, HOUR, 50_000)],
    });
    const result = await createMailboxReader(readerOptions(fake)).fetchNew({ uidValidity: "7", lastUid: 20 });
    expect(result.messages.map((m) => [m.uid, m.size, m.raw === null])).toEqual([
      [21, 2_000_000, true],
      [22, 50_000, false],
    ]);
    expect(result.state.lastUid).toBe(22);
    const sourcePass = fake.calls.filter((call) => call.method === "fetchAll").at(-1);
    expect(sourcePass?.args[0]).toBe("22");
  });

  it("uses imapflow when no client factory is given", async () => {
    const hosts: (string | undefined)[] = [];
    vi.resetModules();
    vi.doMock("imapflow", async (importOriginal) => {
      const real = await importOriginal<typeof import("imapflow")>();
      class RefusingImapFlow extends real.ImapFlow {
        constructor(options: ImapFlowOptions) {
          super(options);
          hosts.push(options.host);
        }
        override async connect(): Promise<void> {
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        }
      }
      return { ...real, ImapFlow: RefusingImapFlow };
    });
    try {
      const { createMailboxReader: createWithImapFlow } = await import("./reader.js");
      const reader = createWithImapFlow({
        host: "imap.example.invalid",
        port: 993,
        user: "mailbox@example.invalid",
        password: "not-a-real-password",
        clock: { now: () => NOW },
      });
      await expect(reader.fetchNew(null)).rejects.toMatchObject({ kind: "connection_failed", code: "ECONNREFUSED" });
      expect(hosts).toEqual(["imap.example.invalid"]);
    } finally {
      vi.doUnmock("imapflow");
      vi.resetModules();
    }
  });

  it("has no code that could change the mailbox", () => {
    const dir = new URL("./", import.meta.url);
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => [name, readFileSync(new URL(name, dir), "utf8")] as const);
    expect(sources.map(([name]) => name).sort()).toEqual(["client.ts", "errors.ts", "reader.ts"]);
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(
        /messageFlags|messageDelete|messageMove|messageCopy|append\(|EXPUNGE|readOnly: false|mailboxCreate|mailboxDelete|mailboxRename|getMailboxLock|\.idle\(/,
      );
    }
  });

  it("opens the mailbox read-only, fetches by uid only and asks for the source once, capped", async () => {
    const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, messages: [message(12, HOUR)] });
    await createMailboxReader(readerOptions(fake, { mailbox: "Alerts", maxMessageBytes: 500_000 })).fetchNew(null);
    expect(fake.calls.find((call) => call.method === "mailboxOpen")?.args).toEqual(["Alerts", { readOnly: true }]);
    const fetches = fake.calls.filter((call) => call.method === "fetchAll");
    expect(fetches.map((call) => call.args[2])).toEqual([{ uid: true }, { uid: true }]);
    expect(fetches.map((call) => call.args[1])).toEqual([
      { uid: true, internalDate: true, size: true },
      { uid: true, internalDate: true, size: true, source: { maxLength: 500_000 } },
    ]);
    expect(new Set(fake.calls.map((call) => call.method))).toEqual(
      new Set(["connect", "mailboxOpen", "search", "fetchAll", "logout"]),
    );
  });

  it("refuses a mailbox the server did not open read-only, and still logs out", async () => {
    const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, readOnly: false, messages: [message(12, HOUR)] });
    await expect(createMailboxReader(readerOptions(fake)).fetchNew(null)).rejects.toMatchObject({
      name: "MailboxError",
      kind: "protocol",
    });
    expect(fake.calls.map((call) => call.method)).toEqual(["connect", "mailboxOpen", "logout"]);
  });

  it("reports a refused login without the password or the server's text", async () => {
    const password = "hunter2-secret";
    const serverText = `NO [AUTHENTICATIONFAILED] bad password ${password}`;
    const loginError = Object.assign(new Error(serverText), {
      authenticationFailed: true,
      responseText: serverText,
      serverResponseCode: "AUTHENTICATIONFAILED",
      response: { attributes: [{ value: password }] },
    });
    const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, failAt: { step: "connect", error: loginError } });
    const err: unknown = await createMailboxReader(readerOptions(fake, { password }))
      .fetchNew(null)
      .catch((caught: unknown) => caught);
    expect(err).toMatchObject({ name: "MailboxError", kind: "auth_failed", message: "Kleinanzeigen mailbox: auth_failed" });
    for (const text of [String(err), JSON.stringify(err), inspect(err, { depth: 5 }), (err as Error).stack ?? ""]) {
      expect(text).not.toContain(password);
      expect(text).not.toContain("bad password");
    }
  });

  it("sorts connection failures into timeout, connection_failed and protocol", async () => {
    const cases = [
      ["GREETING_TIMEOUT", "timeout"],
      ["ECONNREFUSED", "connection_failed"],
      ["CERT_HAS_EXPIRED", "connection_failed"],
      ["SomethingNew", "protocol"],
    ] as const;
    for (const [code, kind] of cases) {
      const error = Object.assign(new Error("socket said something"), { code });
      const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, failAt: { step: "connect", error } });
      await expect(createMailboxReader(readerOptions(fake)).fetchNew(null), code).rejects.toMatchObject({ kind });
    }
  });

  it("gives up after callTimeoutMs, closes the socket and reports a timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, hangAt: "search" });
      const pending = createMailboxReader(readerOptions(fake, { callTimeoutMs: 5_000 }))
        .fetchNew(null)
        .catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fake.calls.map((call) => call.method)).not.toContain("close");
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ name: "MailboxError", kind: "timeout" });
      expect(fake.calls.map((call) => call.method)).toContain("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs out exactly once after success and after a failure at any step", async () => {
    const steps = [undefined, "connect", "mailboxOpen", "search", "fetchAll"] as const;
    for (const step of steps) {
      const fake = createFakeImapClient({
        uidValidity: 7n,
        uidNext: 13,
        messages: [message(12, HOUR)],
        ...(step === undefined ? {} : { failAt: { step, error: new Error("failed") } }),
      });
      await createMailboxReader(readerOptions(fake))
        .fetchNew(null)
        .catch(() => undefined);
      expect(fake.calls.filter((call) => call.method === "logout"), String(step)).toHaveLength(1);
      expect(fake.calls.filter((call) => call.method === "close"), String(step)).toHaveLength(0);
    }
  });

  it("closes the socket when logout fails and keeps the original error", async () => {
    const fake = createFakeImapClient({
      uidValidity: 7n,
      uidNext: 13,
      failAt: { step: "search", error: Object.assign(new Error("lost"), { code: "ECONNRESET" }) },
      failLogout: Object.assign(new Error("logout failed"), { code: "NoConnection" }),
    });
    await expect(createMailboxReader(readerOptions(fake)).fetchNew(null)).rejects.toMatchObject({
      kind: "connection_failed",
      code: "ECONNRESET",
    });
    expect(fake.calls.map((call) => call.method)).toEqual(["connect", "mailboxOpen", "search", "logout", "close"]);
  });

  it("fails instead of skipping the look-back window when the server rejects SEARCH", async () => {
    // imapflow resolves search() with false on a NO, a BAD or a dropped connection.
    const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, messages: [message(12, HOUR)], searchFails: true });
    await expect(createMailboxReader(readerOptions(fake)).fetchNew(null)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("fails instead of reporting a quiet mailbox when the server rejects SEARCH after a known uid", async () => {
    const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, messages: [message(12, HOUR)], searchFails: true });
    await expect(
      createMailboxReader(readerOptions(fake)).fetchNew({ uidValidity: "7", lastUid: 11 }),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("ignores FETCH rows the server sends for other uids or twice for one uid", async () => {
    // A mail client setting \Seen on uid 40 while we fetch makes the server push an extra
    // "* n FETCH (UID 40 FLAGS (\Seen))" row, which imapflow hands back with the result.
    const fake = createFakeImapClient({
      uidValidity: 7n,
      uidNext: 53,
      messages: [message(40, 5 * HOUR), message(51, HOUR), message(52, HOUR)],
      unsolicitedRows: [{ uid: 40 }, { uid: 51 }],
    });
    const result = await createMailboxReader(readerOptions(fake)).fetchNew({ uidValidity: "7", lastUid: 50 });
    expect(result.messages.map((m) => [m.uid, m.internalDate.toISOString(), m.size])).toEqual([
      [51, new Date(NOW.getTime() - HOUR).toISOString(), 60_000],
      [52, new Date(NOW.getTime() - HOUR).toISOString(), 60_000],
    ]);
    expect(result.messages.map((m) => m.raw?.toString())).toEqual(["message 51", "message 52"]);
  });

  it("fails rather than skip a message the server describes without date or size", async () => {
    const fake = createFakeImapClient({
      uidValidity: 7n,
      uidNext: 53,
      messages: [message(51, HOUR), message(52, HOUR)],
      incompleteUids: [51],
    });
    await expect(
      createMailboxReader(readerOptions(fake)).fetchNew({ uidValidity: "7", lastUid: 50 }),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("keeps every FETCH command small when a flood leaves a large backlog", async () => {
    const messages = Array.from({ length: 30_000 }, (_, i) => message(101 + i, HOUR, 5_000));
    for (const state of [null, { uidValidity: "7", lastUid: 100 }]) {
      const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 30_101, messages });
      const result = await createMailboxReader(readerOptions(fake)).fetchNew(state);
      expect([result.messages.length, result.hasMore, result.state.lastUid]).toEqual([25, true, 125]);
      const fetchedUids = fake.calls
        .filter((call) => call.method === "fetchAll")
        .map((call) => String(call.args[0]).split(",").length);
      expect(Math.max(...fetchedUids), JSON.stringify(state)).toBeLessThanOrEqual(25);
    }
  });

  it("starts after the newest uid when the look-back finds nothing", async () => {
    const fake = createFakeImapClient({ uidValidity: 7n, uidNext: 13, messages: [message(12, 3 * 24 * HOUR)] });
    expect(await createMailboxReader(readerOptions(fake)).fetchNew(null)).toEqual({
      state: { uidValidity: "7", lastUid: 12 },
      messages: [],
      hasMore: false,
    });
  });
});
