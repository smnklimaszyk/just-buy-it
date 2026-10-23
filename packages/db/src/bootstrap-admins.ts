import type pg from "pg";
import { recordAuditEvent } from "./audit.js";

// Spec 7.8, run by ops migrate as the owner under the migrate lock: each address of
// AUTH_BOOTSTRAP_ADMINS becomes an active admin, but only while no active admin exists. Removing
// an address from .env later changes nothing. The addresses come normalized from the env parser.
export async function bootstrapAdmins(client: pg.ClientBase, emails: readonly string[]): Promise<{ added: number }> {
  await client.query("BEGIN");
  try {
    // web adds and disables people meanwhile; the lock makes the count and the inserts one step.
    await client.query("LOCK TABLE auth.app_user IN SHARE ROW EXCLUSIVE MODE");
    const admins = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.app_user WHERE role = 'admin' AND status = 'active'",
    );
    if ((admins.rows[0]?.n ?? 0) > 0) {
      await client.query("COMMIT");
      return { added: 0 };
    }
    let added = 0;
    for (const email of emails) {
      const inserted = await client.query<{ at: Date }>(
        // An existing person is never changed (ADR 0038); recovery for them is `ops auth`.
        "INSERT INTO auth.app_user (email, role) VALUES ($1, 'admin') ON CONFLICT (email) DO NOTHING RETURNING now() AS at",
        [email],
      );
      const at = inserted.rows[0]?.at;
      if (at === undefined) continue;
      await recordAuditEvent(client, {
        at,
        actor: "system:bootstrap",
        action: "bootstrap.admin_added",
        detail: { email, role: "admin" },
      });
      added += 1;
    }
    await client.query("COMMIT");
    return { added };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
