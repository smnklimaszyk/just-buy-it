import type { Queryable } from "./pool.js";

export type AuditEventInput = {
  at: Date;
  // "system:cli" for the ops CLI.
  actor: string;
  action: string;
  detail: Record<string, unknown>;
};

const SECRET_FIELD = /password|secret|token|api_?key|pass$/i;

// The first field path whose name looks like a secret, or null.
function secretField(value: unknown, path: string): string | null {
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (SECRET_FIELD.test(key)) return childPath;
    const nested = secretField(child, childPath);
    if (nested !== null) return nested;
  }
  return null;
}

// audit_event never carries a secret: a detail with a field named like one is refused.
export async function recordAuditEvent(db: Queryable, event: AuditEventInput): Promise<void> {
  const secret = secretField(event.detail, "");
  if (secret !== null) throw new Error(`audit detail must not carry a secret field: ${secret}`);
  await db.query("INSERT INTO app.audit_event (at, actor, action, detail) VALUES ($1, $2, $3, $4)", [
    event.at,
    event.actor,
    event.action,
    event.detail,
  ]);
}
