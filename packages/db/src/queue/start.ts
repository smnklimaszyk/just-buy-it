import { PgBoss } from "pg-boss";
import type { Queryable } from "../pool.js";
import { SERVICE_POOLS } from "../pools.js";
import { QUEUE_NAMES, QUEUES, type QueueName, type QueuePayloads } from "./registry.js";
import { PGBOSS_SCHEMA } from "./schema-version.js";

export type JobContext = {
  id: string;
  retryCount: number;
  // Fires at the queue's handler deadline, or when pg-boss gives up on the job. Pass it to every
  // outbound call of the job.
  signal: AbortSignal;
};

export type JobHandler<N extends QueueName> = (payload: QueuePayloads[N], job: JobContext) => Promise<void>;

export type JobQueue = {
  // With `db`, the job is written on that client, inside its open transaction: a rollback leaves
  // no job (section 2.4). Returns null when an exclusive queue already holds a job for the key.
  send<N extends QueueName>(name: N, payload: QueuePayloads[N], options?: { db?: Queryable }): Promise<string | null>;
  work<N extends QueueName>(name: N, handler: JobHandler<N>): Promise<void>;
  // Registers the cron schedules of the registry, in UTC. Running it again changes nothing.
  schedule(): Promise<void>;
  // For the heartbeat: true from a successful start until stop or a stopped event.
  isStarted(): boolean;
  stop(options: { graceful: boolean; timeoutMs: number }): Promise<void>;
};

// The only `new PgBoss(` site. migrate: false: a missing or different schema version makes
// start() throw, so the worker exits 1 and Compose shows it unhealthy (A12, third clause). The
// schema and the queues come from the migrate step.
export async function startQueue(options: {
  connectionString: string;
  onError: (error: Error) => void;
}): Promise<JobQueue> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: PGBOSS_SCHEMA,
    max: SERVICE_POOLS.pgBoss,
    migrate: false,
    schedule: true,
    supervise: true,
    application_name: "ebay-sniper-worker-boss",
  });
  // Without a listener an error event would end the process.
  boss.on("error", options.onError);
  try {
    await boss.start();
  } catch (error) {
    // Closes the pool a failed start may have opened.
    await boss.stop({ graceful: false }).catch(() => undefined);
    throw error;
  }
  return wrap(boss);
}

function wrap(boss: PgBoss): JobQueue {
  let started = true;
  boss.on("stopped", () => {
    started = false;
  });
  return {
    async send(name, payload, sendOptions = {}) {
      const queue = QUEUES[name];
      const data = queue.parse(payload);
      const key = queue.singletonKey(data);
      const db = sendOptions.db;
      return boss.send(name, data, {
        ...(key === null ? {} : { singletonKey: key }),
        ...(db === undefined ? {} : { db: { executeSql: async (text, values) => db.query(text, values) } }),
      });
    },
    async work(name, handler) {
      const queue = QUEUES[name];
      await boss.work(name, { localConcurrency: queue.localConcurrency, batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          const signal = AbortSignal.any([job.signal, AbortSignal.timeout(queue.deadlineMs)]);
          await handler(queue.parse(job.data), { id: job.id, retryCount: job.retryCount, signal });
        }
      });
    },
    async schedule() {
      for (const name of QUEUE_NAMES) {
        const cron = QUEUES[name].cron;
        if (cron !== null) await boss.schedule(name, cron, {}, { tz: "UTC" });
      }
    },
    isStarted() {
      return started;
    },
    async stop(stopOptions) {
      started = false;
      await boss.stop({ graceful: stopOptions.graceful, timeout: stopOptions.timeoutMs });
    },
  };
}
