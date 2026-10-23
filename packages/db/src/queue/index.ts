// @ebay-sniper/db/queue: the pg-boss wrapper, the migrate step and the role setup (section 2.1).
// pg-boss is imported only below packages/db/src/queue.
export {
  checkDashboardRole,
  checkWebRole,
  checkWorkerRole,
  RoleCheckError,
  setRolePassword,
  type ServiceRole,
} from "../app-role.js";
export { bootstrapAdmins } from "../bootstrap-admins.js";
export { migrateQueue, QueueSchemaVersionError, type QueueMigrateResult } from "./migrate-queue.js";
export {
  deadLetterName,
  QUEUE_DELETE_AFTER_SECONDS,
  QUEUE_NAMES,
  QUEUE_RETENTION_SECONDS,
  QueuePayloadError,
  QUEUES,
  WORKER_POOL_MAX,
  type QueueDefinition,
  type QueueName,
  type QueuePayloads,
} from "./registry.js";
export { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION } from "./schema-version.js";
export { startQueue, type JobContext, type JobHandler, type JobQueue } from "./start.js";
