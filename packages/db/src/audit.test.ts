import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { recordAuditEvent } from "./audit.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

const AT = new Date("2026-10-21T12:00:00.000Z");

describe("recordAuditEvent", () => {
  it("writes the event, and refuses a detail with a field named like a secret at any depth", async () => {
    await recordAuditEvent(database.pool, { at: AT, actor: "system:cli", action: "migrate.roles", detail: { roles: ["worker"] } });

    await expect(
      recordAuditEvent(database.pool, { at: AT, actor: "system:cli", action: "x", detail: { smtp: { password: "p" } } }),
    ).rejects.toThrow("audit detail must not carry a secret field: smtp.password");
    await expect(
      recordAuditEvent(database.pool, { at: AT, actor: "system:cli", action: "x", detail: { apiKey: "k" } }),
    ).rejects.toThrow("audit detail must not carry a secret field: apiKey");
    const rows = await database.pool.query("SELECT at, actor, action, detail FROM app.audit_event");
    expect(rows.rows).toEqual([{ at: AT, actor: "system:cli", action: "migrate.roles", detail: { roles: ["worker"] } }]);
  });
});
