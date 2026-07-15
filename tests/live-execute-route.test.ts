import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { defaultBotSettings } from "@/lib/bot-settings";
import type { Opportunity } from "@/lib/bot/types";
import {
  bitgetLiveRouteConfigurationBlocker,
  finalizeSuccessfulTriangleExecution,
  isDashboardRequest,
  persistRecoveredTrianglePnl,
  selectLiveOpportunityForExecution,
  type TriangleFinalizationDependencies,
  type BitgetLiveRouteConfiguration
} from "@/app/api/live/execute/route";

const validConfiguration: BitgetLiveRouteConfiguration = {
  BITGET_API_BASE: "https://api.bitget.com",
  BITGET_WS_PUBLIC: "wss://ws.bitget.com/v2/ws/public",
  BITGET_API_KEY: "api-key",
  BITGET_API_SECRET: "api-secret",
  BITGET_API_PASSPHRASE: "api-passphrase",
  bitgetAccountMode: "classic",
  bitgetDemoTrading: false
};

describe("Triangle Live execution route fences", () => {
  test("accepts only official Bitget transports and all three credentials", () => {
    expect(bitgetLiveRouteConfigurationBlocker(validConfiguration)).toBeUndefined();
    expect(bitgetLiveRouteConfigurationBlocker({
      ...validConfiguration,
      BITGET_API_BASE: "https://api.bitget.com.evil.example"
    })).toBe("official-bitget-mainnet-required");
    expect(bitgetLiveRouteConfigurationBlocker({
      ...validConfiguration,
      BITGET_API_PASSPHRASE: ""
    })).toBe("bitget-live-credentials-missing");
    expect(bitgetLiveRouteConfigurationBlocker({
      ...validConfiguration,
      bitgetDemoTrading: true
    })).toBeUndefined();
    expect(bitgetLiveRouteConfigurationBlocker({
      ...validConfiguration,
      bitgetAccountMode: "uta"
    })).toBeUndefined();
    expect(bitgetLiveRouteConfigurationBlocker({
      ...validConfiguration,
      BITGET_WS_PUBLIC: "wss://attacker.example/v2/ws/public"
    })).toBe("official-bitget-websocket-required");
  });

  test("requires the Bitget dashboard action header and same origin", () => {
    const request = dashboardRequest();
    expect(isDashboardRequest(request)).toBe(true);
    expect(isDashboardRequest(dashboardRequest({ action: "wrong-dashboard" }))).toBe(false);
    expect(isDashboardRequest(dashboardRequest({ origin: "https://evil.example" }))).toBe(false);
  });

  test("applies the final Live safety margin to every candidate before choosing the best safe route", () => {
    const unsafeFirst = opportunity("unsafe-high-profit", 100_000, 200);
    const safeSecond = opportunity("safe-lower-profit", 1_000, 10);

    const { best } = selectLiveOpportunityForExecution(
      [unsafeFirst, safeSecond],
      defaultBotSettings
    );

    expect(unsafeFirst.executable).toBe(false);
    expect(unsafeFirst.rejectionReason).toContain("Live");
    expect(safeSecond.executable).toBe(true);
    expect(best?.id).toBe("safe-lower-profit");
  });

  test("an explicitly triggered unsafe route is rejected with its Live safety reason", () => {
    const unsafe = opportunity("unsafe-trigger", 100_000, 200);
    const selected = selectLiveOpportunityForExecution([unsafe], defaultBotSettings, {
      triggerOpportunityId: unsafe.id,
      triggerRoute: unsafe.route
    });

    expect(selected.best).toBeUndefined();
    expect(selected.triggerCandidate?.rejectionReason).toContain("Live");
  });
});

describe("Triangle successful-execution finalization", () => {
  test("records idempotent risk PnL before closing the execution and then writes completion evidence", async () => {
    const calls: string[] = [];
    const deps = finalizationDependencies({
      recordPnl: async (_pnl, _now, idempotency) => { calls.push(`pnl:${idempotency.idempotencyKey}`); },
      appendEvent: async (_id, type) => { calls.push(`event:${type}`); },
      complete: async () => { calls.push("complete"); }
    });

    const warnings = await finalizeSuccessfulTriangleExecution(42, successfulExecution(), deps);

    expect(warnings).toEqual([]);
    expect(calls).toEqual([
      "pnl:triangle:42:pnl",
      "event:PNL_RECORDED",
      "complete",
      "event:COMPLETED"
    ]);
  });

  test("never marks the row completed when authoritative risk accounting fails", async () => {
    const calls: string[] = [];
    const deps = finalizationDependencies({
      recordPnl: async () => { calls.push("pnl"); throw new Error("risk disk unavailable"); },
      complete: async () => { calls.push("complete"); },
      emergencyStop: async reason => { calls.push(`stop:${reason}`); }
    });

    await expect(finalizeSuccessfulTriangleExecution(43, successfulExecution(), deps))
      .rejects.toThrow("risk disk unavailable");
    expect(calls).toEqual(["pnl", "stop:triangle-risk-accounting-failed"]);
  });

  test("retries the same PnL key without double-accounting after a completion crash window", async () => {
    const recordedKeys = new Set<string>();
    let accountingMutations = 0;
    let completionAttempts = 0;
    const deps = finalizationDependencies({
      recordPnl: async (_pnl, _now, idempotency) => {
        if (!recordedKeys.has(idempotency.idempotencyKey)) accountingMutations += 1;
        recordedKeys.add(idempotency.idempotencyKey);
      },
      complete: async () => {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("execution db interrupted");
      }
    });

    await expect(finalizeSuccessfulTriangleExecution(44, successfulExecution(), deps))
      .rejects.toThrow("execution db interrupted");
    await finalizeSuccessfulTriangleExecution(44, successfulExecution(), deps);

    expect([...recordedKeys]).toEqual(["triangle:44:pnl"]);
    expect(accountingMutations).toBe(1);
    expect(completionAttempts).toBe(2);
  });

  test("a PnL-ledger failure durably stops Live before completion continues", async () => {
    const calls: string[] = [];
    const deps = finalizationDependencies({
      recordPnl: async () => { calls.push("pnl"); },
      appendEvent: async (_id, type) => {
        calls.push(`event:${type}`);
        if (type === "PNL_RECORDED") throw new Error("ledger unavailable");
      },
      emergencyStop: async reason => { calls.push(`stop:${reason}`); },
      complete: async () => { calls.push("complete"); }
    });

    const warnings = await finalizeSuccessfulTriangleExecution(45, successfulExecution(), deps);

    expect(warnings).toHaveLength(1);
    expect(calls).toEqual([
      "pnl",
      "event:PNL_RECORDED",
      "stop:triangle-pnl-ledger-write-failed",
      "complete",
      "event:COMPLETED"
    ]);
  });
});

describe("Triangle recovered-cycle accounting barrier", () => {
  test("makes risk PnL, immutable evidence and Emergency Stop durable in order", async () => {
    const calls: string[] = [];
    const result = await persistRecoveredTrianglePnl(51, recoveredPnl(), finalizationDependencies({
      recordPnl: async (_pnl, _now, idempotency) => { calls.push(`pnl:${idempotency.idempotencyKey}`); },
      appendEvent: async (_id, type) => { calls.push(`event:${type}`); },
      emergencyStop: async reason => { calls.push(`stop:${reason}`); }
    }));

    expect(result.safeToClose).toBe(true);
    expect(calls).toEqual([
      "pnl:triangle:51:pnl",
      "event:PNL_RECORDED",
      "stop:triangle-cycle-failed-after-automatic-recovery"
    ]);
  });

  test("keeps the mutable row nonterminal when recovered PnL cannot be recorded", async () => {
    const calls: string[] = [];
    const result = await persistRecoveredTrianglePnl(52, recoveredPnl(), finalizationDependencies({
      recordPnl: async () => { calls.push("pnl"); throw new Error("risk unavailable"); },
      appendEvent: async () => { calls.push("event"); },
      emergencyStop: async reason => { calls.push(`stop:${reason}`); }
    }));

    expect(result.safeToClose).toBe(false);
    expect(calls).toEqual(["pnl", "stop:triangle-recovery-risk-accounting-failed"]);
  });

  test("keeps the row nonterminal after a PnL-ledger failure even when stop succeeds", async () => {
    const calls: string[] = [];
    const result = await persistRecoveredTrianglePnl(53, recoveredPnl(), finalizationDependencies({
      recordPnl: async () => { calls.push("pnl"); },
      appendEvent: async () => { calls.push("event"); throw new Error("ledger unavailable"); },
      emergencyStop: async reason => { calls.push(`stop:${reason}`); }
    }));

    expect(result.safeToClose).toBe(false);
    expect(calls).toEqual(["pnl", "event", "stop:triangle-recovery-pnl-ledger-write-failed"]);
  });

  test("keeps the row nonterminal if the mandatory recovery stop is not durable", async () => {
    const result = await persistRecoveredTrianglePnl(54, recoveredPnl(), finalizationDependencies({
      emergencyStop: async () => { throw new Error("risk state unavailable"); }
    }));

    expect(result.safeToClose).toBe(false);
    expect(result.warnings.join(" ")).toContain("risk state unavailable");
  });
});

function dashboardRequest(input: { action?: string; origin?: string } = {}) {
  return new Request("https://api.bitget.com/api/live/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "api.bitget.com",
      origin: input.origin ?? "https://api.bitget.com",
      "x-live-action": input.action ?? "bitget-dashboard"
    },
    body: "{}"
  });
}

function opportunity(id: string, input: number, profit: number): Opportunity {
  const inputAmount = new Decimal(input);
  return {
    id,
    route: ["USDT", "BTC", "ETH", "USDT"],
    legs: [],
    requestedInputToman: inputAmount,
    inputToman: inputAmount,
    outputToman: inputAmount.plus(profit),
    netProfitToman: new Decimal(profit),
    profitBps: new Decimal(profit).div(inputAmount).mul(10_000),
    liquiditySafe: true,
    executable: true,
    sizedByDepth: false,
    sizingMode: "optimized",
    scannedAt: 1_800_000_000_000
  };
}

function successfulExecution(): Parameters<typeof finalizeSuccessfulTriangleExecution>[1] {
  return {
    requestedInputToman: new Decimal(10),
    inputToman: new Decimal(10),
    outputToman: new Decimal("10.02"),
    profitToman: new Decimal("0.02"),
    realizedOutputToman: new Decimal("10.02"),
    realizedProfitToman: new Decimal("0.02"),
    residualInventory: [],
    residualValueToman: new Decimal(0),
    externalFeeValueToman: new Decimal(0),
    fullySettled: true,
    legs: []
  };
}

function finalizationDependencies(
  overrides: Partial<TriangleFinalizationDependencies> = {}
): TriangleFinalizationDependencies {
  return {
    recordPnl: async () => undefined,
    appendEvent: async () => undefined,
    complete: async () => undefined,
    emergencyStop: async () => undefined,
    now: () => new Date("2026-07-15T12:00:00.000Z"),
    ...overrides
  };
}

function recoveredPnl() {
  return {
    economicPnl: -0.5,
    pnlToman: "-0.5",
    realizedPnlToman: "-0.6",
    residualValueToman: "0.1",
    fullySettled: false
  };
}
