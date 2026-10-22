import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { insertAlert, type AlertInput } from "./alert.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

const T0 = new Date("2026-10-21T10:00:00.000Z");
const key = (n: number) => n.toString(16).padStart(64, "0");

const alertInput = (n: number): AlertInput => ({
  itemKey: key(n),
  candidateId: "00000000-0000-7000-8000-000000000001",
  screeningId: null,
  segment: "gpu_3090",
  finalVerdict: "caution",
  modelVerdict: null,
  blockedByCode: false,
  screened: false,
  flags: ["best_offer"],
  priceCents: 45900,
  shippingCents: 3000,
  landedCents: 48900,
  ruleVersion: 1,
  buyerProfile: "company",
  createdAt: T0,
});

describe("insertAlert", () => {
  it("makes one alert per item with kind band, tier none and seq 1, and returns the same alert on a repeat", async () => {
    const first = await insertAlert(database.pool, alertInput(1));
    const repeat = await insertAlert(database.pool, { ...alertInput(1), finalVerdict: "pass" });

    expect(first.created).toBe(true);
    expect(repeat).toEqual({ id: first.id, created: false });
    const rows = await database.pool.query("SELECT kind, tier, seq, final_verdict, flags, created_at FROM app.alert");
    expect(rows.rows).toEqual([{ kind: "band", tier: "none", seq: 1, final_verdict: "caution", flags: ["best_offer"], created_at: T0 }]);
  });
});
