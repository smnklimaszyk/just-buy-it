import { ImapFlow } from "imapflow";

// The only IMAP surface the reader uses. It has no method that writes: no flag, move, copy,
// delete, append or mailbox change, and the mailbox is opened read-only (EXAMINE).
export type ImapClient = {
  connect(): Promise<void>;
  mailboxOpen(
    path: string,
    options: { readOnly: true },
  ): Promise<{ uidValidity: bigint; uidNext: number; readOnly?: boolean | undefined }>;
  search(query: { uid: string } | { since: Date }, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(
    range: string,
    query: { uid: true; internalDate: true; size: true; source?: { maxLength: number } },
    options: { uid: true },
  ): Promise<{ uid: number; internalDate?: Date | string | undefined; size?: number | undefined; source?: Buffer | undefined }[]>;
  logout(): Promise<void>;
  close(): void;
};

export type ImapClientConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  maxMessageBytes: number;
  connectTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
};

// TLS certificate checks stay at imapflow's default (on). The logger is off because imapflow's log
// lines can carry server text.
export function createImapFlowClient(config: ImapClientConfig, Flow: typeof ImapFlow = ImapFlow): ImapClient {
  const flow = new Flow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: config.connectTimeoutMs,
    greetingTimeout: config.greetingTimeoutMs,
    socketTimeout: config.socketTimeoutMs,
    // Room for the largest message we read plus the command around it.
    maxLiteralSize: config.maxMessageBytes + 65_536,
  });
  // imapflow also emits socket errors as events; an EventEmitter without an "error" listener
  // throws them and takes the process down. The same failure reaches the caller as a rejected call.
  flow.on("error", () => undefined);
  return {
    connect: () => flow.connect(),
    mailboxOpen: (path, options) => flow.mailboxOpen(path, options),
    search: (query, options) => flow.search(query, options),
    fetchAll: (range, query, options) => flow.fetchAll(range, query, options),
    logout: () => flow.logout(),
    close: () => flow.close(),
  };
}
