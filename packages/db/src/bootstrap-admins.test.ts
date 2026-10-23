import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { bootstrapAdmins } from "./bootstrap-admins.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Spec 7.8: ops migrate adds each AUTH_BOOTSTRAP_ADMINS address as active admin only when no
// active admin exists, audited as system:bootstrap.

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("TRUNCATE auth.app_user CASCADE");
  await database.pool.query("TRUNCATE app.audit_event");
});

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function people(): Promise<{ email: string; role: string; status: string; created_by: string | null }[]> {
  const result = await database.pool.query<{ email: string; role: string; status: string; created_by: string | null }>(
    "SELECT email, role, status, created_by FROM auth.app_user ORDER BY email",
  );
  return result.rows;
}

describe("bootstrapAdmins", () => {
  it("adds each address as active admin when nobody is admin yet, and audits each one", async () => {
    const result = await withClient((client) => bootstrapAdmins(client, ["info@intra-ai.de", "second@example.org"]));

    expect(result).toEqual({ added: 2 });
    expect(await people()).toEqual([
      { email: "info@intra-ai.de", role: "admin", status: "active", created_by: null },
      { email: "second@example.org", role: "admin", status: "active", created_by: null },
    ]);
    const audit = await database.pool.query("SELECT actor, action, detail FROM app.audit_event ORDER BY detail->>'email'");
    expect(audit.rows).toEqual([
      { actor: "system:bootstrap", action: "bootstrap.admin_added", detail: { email: "info@intra-ai.de", role: "admin" } },
      { actor: "system:bootstrap", action: "bootstrap.admin_added", detail: { email: "second@example.org", role: "admin" } },
    ]);
  });

  it("adds nobody once an active admin exists, and counts neither editors nor disabled admins as one", async () => {
    await database.pool.query(
      `INSERT INTO auth.app_user (email, role, status, disabled_at) VALUES
         ('editor@example.org', 'editor', 'active', NULL), ('gone@example.org', 'admin', 'disabled', now())`,
    );
    expect(await withClient((client) => bootstrapAdmins(client, ["info@intra-ai.de"]))).toEqual({ added: 1 });

    expect(await withClient((client) => bootstrapAdmins(client, ["info@intra-ai.de", "new@example.org"]))).toEqual({
      added: 0,
    });
    expect((await people()).map((person) => person.email)).toEqual([
      "editor@example.org",
      "gone@example.org",
      "info@intra-ai.de",
    ]);
    const audit = await database.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM app.audit_event");
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("never changes a person who exists, whatever the case of the listed address", async () => {
    await database.pool.query(
      "INSERT INTO auth.app_user (email, role, status, disabled_at) VALUES ('info@intra-ai.de', 'admin', 'disabled', now())",
    );

    const result = await withClient((client) => bootstrapAdmins(client, ["INFO@intra-ai.de", "second@example.org"]));

    expect(result).toEqual({ added: 1 });
    expect(await people()).toEqual([
      { email: "info@intra-ai.de", role: "admin", status: "disabled", created_by: null },
      { email: "second@example.org", role: "admin", status: "active", created_by: null },
    ]);
  });

  it("adds each admin once when two runs start together", async () => {
    const results = await Promise.all([
      withClient((client) => bootstrapAdmins(client, ["info@intra-ai.de", "second@example.org"])),
      withClient((client) => bootstrapAdmins(client, ["info@intra-ai.de", "second@example.org"])),
    ]);

    expect(results.map((result) => result.added).sort()).toEqual([0, 2]);
    const audit = await database.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM app.audit_event");
    expect(audit.rows[0]?.n).toBe(2);
  });
});
