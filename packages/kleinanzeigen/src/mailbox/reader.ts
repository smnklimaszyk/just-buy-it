import { createImapFlowClient, type ImapClient, type ImapClientConfig } from "./client.js";
import { MailboxError, toMailboxError } from "./errors.js";

export type MailboxState = { uidValidity: string; lastUid: number };
export type MailboxMessage = { uid: number; internalDate: Date; size: number; raw: Buffer | null };
export type FetchNewResult = { state: MailboxState; messages: MailboxMessage[]; hasMore: boolean };
export type MailboxReader = { fetchNew(state: MailboxState | null): Promise<FetchNewResult> };

export type MailboxReaderOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox?: string;
  clock: { now(): Date };
  lookBackMs?: number;
  maxMessages?: number;
  maxMessageBytes?: number;
  connectTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
  callTimeoutMs?: number;
  // Tests pass the in-memory fake here.
  createClient?: (config: ImapClientConfig) => ImapClient;
};

const DAY_MS = 86_400_000;
const DEFAULT_LOOK_BACK_MS = DAY_MS;
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;
const DEFAULT_MAX_MESSAGES = 25;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

type Metadata = { uid: number; internalDate: Date; size: number };

// imapflow returns every FETCH row the server sends while the command runs, including rows for
// other messages (a flag change made by another client) and a second row for a message we asked
// for. Only the first complete row of each requested uid counts. A requested message that comes
// back without date or size fails the call: skipping it would move the state past it.
function metadataOf(
  rows: { uid: number; internalDate?: Date | string | undefined; size?: number | undefined }[],
  requested: number[],
): Metadata[] {
  const byUid = new Map<number, Metadata>();
  const answered = new Set<number>();
  for (const row of rows) {
    if (!requested.includes(row.uid)) continue;
    answered.add(row.uid);
    const internalDate = new Date(row.internalDate ?? Number.NaN);
    if (byUid.has(row.uid) || Number.isNaN(internalDate.getTime()) || row.size === undefined) continue;
    byUid.set(row.uid, { uid: row.uid, internalDate, size: row.size });
  }
  if (answered.size !== byUid.size) throw new MailboxError("protocol");
  return [...byUid.values()];
}

// imapflow resolves search() with false when the server answers NO or BAD or the connection drops,
// and logs nothing with its logger off. Read as "no mail", that would move the state past mail
// that was never read.
function searchResult(found: number[] | false | undefined): number[] {
  if (!Array.isArray(found)) throw new MailboxError("protocol");
  return found;
}

export function createMailboxReader(options: MailboxReaderOptions): MailboxReader {
  const mailbox = options.mailbox ?? "INBOX";
  const lookBackMs = options.lookBackMs ?? DEFAULT_LOOK_BACK_MS;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  async function fetchNew(state: MailboxState | null): Promise<FetchNewResult> {
    const client = (options.createClient ?? createImapFlowClient)({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      maxMessageBytes,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      greetingTimeoutMs: options.greetingTimeoutMs ?? 10_000,
      socketTimeoutMs: options.socketTimeoutMs ?? 30_000,
    });
    // One deadline for the whole call; on expiry the socket is dropped, which also ends any command
    // still waiting on the server.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        client.close();
        reject(new MailboxError("timeout"));
      }, callTimeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          await client.connect();
          return read(client, state);
        })(),
        deadline,
      ]);
    } catch (err) {
      throw toMailboxError(err);
    } finally {
      clearTimeout(timer);
      // A failed logout never replaces the error the caller sees; the socket is dropped instead.
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  async function read(client: ImapClient, state: MailboxState | null): Promise<FetchNewResult> {
    const box = await client.mailboxOpen(mailbox, { readOnly: true });
    // imapflow sends EXAMINE; a server that still opened the mailbox for writing gets no further.
    if (box.readOnly !== true) throw new MailboxError("protocol");
    const uidValidity = String(box.uidValidity);
    const continuing = state !== null && state.uidValidity === uidValidity;
    let uids: number[];
    let since: Date | null = null;
    if (continuing) {
      // "N:*" also returns the highest uid when it is below N, so filter again.
      uids = searchResult(await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })).filter(
        (uid) => uid > state.lastUid,
      );
    } else {
      // No state, or the mailbox was rebuilt: uids from before mean nothing, read the recent past.
      since = new Date(options.clock.now().getTime() - lookBackMs);
      // IMAP SINCE has day granularity, so ask from the day before and filter by the exact time below.
      const searchFrom = new Date(Math.floor(since.getTime() / DAY_MS) * DAY_MS - DAY_MS);
      uids = searchResult(await client.search({ since: searchFrom }, { uid: true }));
    }
    uids.sort((a, b) => a - b);
    // Metadata in chunks of maxMessages uids, oldest first, until enough are taken: a flood of mail
    // must not turn into one FETCH command longer than the server accepts.
    const found: Metadata[] = [];
    let next = 0;
    while (next < uids.length && found.length < maxMessages) {
      const chunk = uids.slice(next, next + maxMessages);
      next += chunk.length;
      const rows = await client.fetchAll(chunk.join(","), { uid: true, internalDate: true, size: true }, { uid: true });
      found.push(
        ...metadataOf(rows, chunk)
          .filter((m) => since === null || m.internalDate.getTime() >= since.getTime())
          .sort((a, b) => a.uid - b.uid),
      );
    }
    const metadata = found.slice(0, maxMessages);
    const sources = new Map<number, Buffer>();
    const wanted = metadata.filter((m) => m.size <= maxMessageBytes).map((m) => m.uid);
    if (wanted.length > 0) {
      const query = { uid: true, internalDate: true, size: true, source: { maxLength: maxMessageBytes } } as const;
      for (const m of await client.fetchAll(wanted.join(","), query, { uid: true })) {
        if (m.source !== undefined && wanted.includes(m.uid) && !sources.has(m.uid)) sources.set(m.uid, m.source);
      }
    }
    const messages = metadata.map((m) => ({ ...m, raw: sources.get(m.uid) ?? null }));
    // Nothing new: keep the stored uid, or after a look-back skip the older mail next time.
    const lastUid = messages.at(-1)?.uid ?? (continuing ? state.lastUid : box.uidNext - 1);
    const hasMore = found.length > metadata.length || next < uids.length;
    return { state: { uidValidity, lastUid }, messages, hasMore };
  }

  return { fetchNew };
}
