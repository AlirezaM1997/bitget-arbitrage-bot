import { describe, expect, test } from "bun:test";
import { handleAdminDatabasePurge } from "@/app/api/admin/database/route";

function request(input: unknown = { confirmation: "DELETE_ALL_DATABASE_DATA" }, origin = "http://localhost:3000", action = "purge-all-database-data") {
  return new Request("http://localhost:3000/api/admin/database", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      origin,
      host: "localhost:3000",
      "x-admin-action": action
    },
    body: JSON.stringify(input)
  });
}

function dependencies(options: { masterArmed?: boolean; leases?: number; unsafeTriangle?: number; unsafeStrategies?: number } = {}) {
  const calls: string[] = [];
  const value = {
    riskSnapshot: async () => ({ state: { masterArmed: options.masterArmed ?? false } }) as never,
    executionLeases: async () => Array.from({ length: options.leases ?? 0 }, (_, slot) => ({ slot })) as never,
    unsafeTriangleRecords: async () => options.unsafeTriangle ?? 0,
    unsafeStrategyRecords: async () => options.unsafeStrategies ?? 0,
    purgeOpportunityDatabase: async () => { calls.push("opportunities"); return { opportunities: 3, liveExecutions: 2, total: 5 }; },
    purgeStrategyDatabase: async () => { calls.push("strategies"); return { executions: 4, orders: 6, transitions: 8, total: 18 }; },
    purgeExecutionLedger: async () => { calls.push("ledger"); return { events: 9, total: 9 }; }
  };
  return { calls, value };
}

describe("administrative database purge", () => {
  test("rejects foreign requests and an incorrect confirmation before reading state", async () => {
    const mocked = dependencies();
    expect((await handleAdminDatabasePurge(request(undefined, "https://attacker.example"), mocked.value)).status).toBe(403);
    expect((await handleAdminDatabasePurge(request({ confirmation: "DELETE" }), mocked.value)).status).toBe(400);
    expect(mocked.calls).toEqual([]);
  });

  test("requires Master Live to be off and every execution lease to be released", async () => {
    const armed = dependencies({ masterArmed: true });
    expect((await handleAdminDatabasePurge(request(), armed.value)).status).toBe(409);
    const leased = dependencies({ leases: 1 });
    expect((await handleAdminDatabasePurge(request(), leased.value)).status).toBe(409);
    expect(armed.calls).toEqual([]);
    expect(leased.calls).toEqual([]);
  });

  test("preserves databases while an open or ambiguous execution exists", async () => {
    const mocked = dependencies({ unsafeTriangle: 1, unsafeStrategies: 2 });
    const response = await handleAdminDatabasePurge(request(), mocked.value);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ unsafeRecords: { triangle: 1, strategies: 2 } });
    expect(mocked.calls).toEqual([]);
  });

  test("purges all three databases in audit-last order", async () => {
    const mocked = dependencies();
    const response = await handleAdminDatabasePurge(request(), mocked.value);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(mocked.calls).toEqual(["opportunities", "strategies", "ledger"]);
    expect(json.deleted.total).toBe(32);
    expect(json.preserved).toEqual(["bot-settings", "risk-state", "environment", "api-credentials"]);
  });
});
