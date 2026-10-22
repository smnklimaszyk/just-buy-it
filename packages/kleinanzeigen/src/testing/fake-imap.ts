// An in-memory ImapClient for tests in this package. Not built, not exported. It records every
// call with its arguments and can be told to fail or hang at any step. No socket is opened.
import type { ImapClient } from "../mailbox/client.js";

export type FakeMessage = { uid: number; internalDate: Date; size: number; source: Buffer };

export type FakeStep = "connect" | "mailboxOpen" | "search" | "fetchAll" | "logout";

export type FakeImapOptions = {
  uidValidity: bigint;
  uidNext: number;
  messages?: FakeMessage[];
  // What mailboxOpen reports; a server that ignored EXAMINE would say false.
  readOnly?: boolean;
  // Reject the first call of a step with this error.
  failAt?: { step: FakeStep; error: unknown };
  // Never settle the first call of a step.
  hangAt?: FakeStep;
  // Reject logout with this error, on top of any failAt.
  failLogout?: unknown;
  // Resolve search with false, as imapflow does when the server answers NO or BAD or the
  // connection drops during SEARCH.
  searchFails?: boolean;
  // Rows the server pushes during every FETCH whatever was asked, such as a flag change another
  // client made; imapflow puts them into the fetchAll result.
  unsolicitedRows?: { uid: number }[];
  // Answer FETCH for these uids with the uid alone, as a server that leaves out INTERNALDATE
  // and RFC822.SIZE would.
  incompleteUids?: number[];
};

export type FakeCall = { method: keyof ImapClient; args: unknown[] };

export type FakeImap = { client: ImapClient; calls: FakeCall[] };

const DAY = 86_400_000;

export function createFakeImapClient(options: FakeImapOptions): FakeImap {
  const calls: FakeCall[] = [];
  const messages = [...(options.messages ?? [])].sort((a, b) => a.uid - b.uid);

  function step<T>(name: FakeStep, args: unknown[], run: () => T): Promise<T> {
    calls.push({ method: name, args });
    if (options.hangAt === name) return new Promise<T>(() => undefined);
    if (options.failAt?.step === name) return Promise.reject(options.failAt.error);
    if (name === "logout" && options.failLogout !== undefined) return Promise.reject(options.failLogout);
    return Promise.resolve(run());
  }

  const client: ImapClient = {
    connect: () => step("connect", [], () => undefined),
    mailboxOpen: (path, openOptions) =>
      step("mailboxOpen", [path, openOptions], () => ({
        uidValidity: options.uidValidity,
        uidNext: options.uidNext,
        readOnly: options.readOnly ?? true,
      })),
    search: (query, searchOptions) =>
      step("search", [query, searchOptions], (): number[] | false => {
        if (options.searchFails === true) return false;
        if ("since" in query) {
          // IMAP SINCE compares whole days and ignores the time.
          const day = Math.floor(query.since.getTime() / DAY) * DAY;
          return messages.filter((m) => m.internalDate.getTime() >= day).map((m) => m.uid);
        }
        // "N:*" always includes the highest uid, even when it is below N (RFC 3501 section 6.4.8).
        const from = Number(query.uid.split(":")[0]);
        const found = messages.filter((m) => m.uid >= from).map((m) => m.uid);
        const last = messages.at(-1);
        return found.length === 0 && last !== undefined ? [last.uid] : found;
      }),
    fetchAll: (range, query, fetchOptions) =>
      step("fetchAll", [range, query, fetchOptions], () => {
        const uids = new Set(range.split(",").map(Number));
        return [
          ...(options.unsolicitedRows ?? []),
          ...messages
            .filter((m) => uids.has(m.uid))
            .map((m) => (options.incompleteUids?.includes(m.uid) ? { uid: m.uid } : {
              uid: m.uid,
              internalDate: m.internalDate,
              size: m.size,
              ...(query.source === undefined ? {} : { source: m.source.subarray(0, query.source.maxLength) }),
            })),
        ];
      }),
    logout: () => step("logout", [], () => undefined),
    close: () => {
      calls.push({ method: "close", args: [] });
    },
  };
  return { client, calls };
}
