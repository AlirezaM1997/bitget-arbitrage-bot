import { describe, expect, test } from "bun:test";
import { handleClearExecutionHistory } from "@/app/api/executions/route";

function request(origin = "http://localhost:3000", action = "clear-execution-history") {
  return new Request("http://localhost:3000/api/executions", {
    method: "DELETE",
    headers: {
      origin,
      host: "localhost:3000",
      "x-history-action": action
    }
  });
}

function dependencies(masterArmed = false) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      riskSnapshot: async () => ({ state: { masterArmed } }) as never,
      clearTriangle: async () => { calls.push("triangle"); return 2; },
      clearStrategies: async () => { calls.push("strategies"); return 3; },
      triangleHistory: async () => ({ summary: { attemptCount: 0 }, records: [] }) as never,
      strategyHistory: async () => ({ summary: { totalCount: 1 }, records: [{ id: 9, state: "RECOVERING" }] }) as never
    }
  };
}

describe("combined execution-history cleanup", () => {
  test("rejects foreign or missing dashboard authorization before touching stores", async () => {
    const mocked = dependencies();
    expect((await handleClearExecutionHistory(request("https://attacker.example"), mocked.value)).status).toBe(403);
    expect((await handleClearExecutionHistory(request("http://localhost:3000", "wrong"), mocked.value)).status).toBe(403);
    expect(mocked.calls).toEqual([]);
  });

  test("requires Master Live to be off", async () => {
    const mocked = dependencies(true);
    const response = await handleClearExecutionHistory(request(), mocked.value);
    expect(response.status).toBe(409);
    expect(mocked.calls).toEqual([]);
  });

  test("clears both closed-history stores and returns refreshed feed state", async () => {
    const mocked = dependencies();
    const response = await handleClearExecutionHistory(request(), mocked.value);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(mocked.calls).toEqual(["triangle", "strategies"]);
    expect(json.deletedCount).toEqual({ triangle: 2, strategies: 3, total: 5 });
    expect(json.remainingCount).toBe(1);
    expect(json.liveExecutions.records).toEqual([]);
    expect(json.strategyExecutions.records[0].state).toBe("RECOVERING");
  });
});
