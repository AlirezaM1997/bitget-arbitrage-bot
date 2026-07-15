import { beforeEach, describe, expect, test } from "bun:test";

process.env.STRATEGY_EXECUTION_DB_PATH = ":memory:";

const store = await import("@/lib/strategy-execution-store");

describe("strategy execution state store", () => {
  beforeEach(async () => {
    await store.clearStrategyExecutionStore();
  });

  test("persists the complete execution, order and transition audit trail", async () => {
    const created = await store.createStrategyExecution({
      strategy: "audit-test-engine",
      signalId: "signal-1",
      symbols: ["BTCUSDT", "BTCUSDT", "USDTUSDT"],
      direction: "USDT_TO_USDT",
      requestedCapitalToman: 1_000_000,
      plannedProfitToman: 25_000,
      detectedAt: 1_000,
      metadata: { expectedEdgeBps: 250 }
    });

    expect(created.state).toBe("DETECTED");
    expect(created.transitions.map(item => item.toState)).toEqual(["DETECTED"]);

    await store.transitionStrategyExecution(created.id, "REVALIDATING", { at: 1_100 });
    await store.transitionStrategyExecution(created.id, "SUBMITTING", {
      at: 1_200,
      note: "fresh books accepted",
      metadata: { revalidated: true }
    });
    const order = await store.addStrategyExecutionOrder(created.id, {
      legIndex: 0,
      symbol: "BTCUSDT",
      side: "BUY",
      status: "Done",
      exchangeOrderId: "order-123",
      requestedAmount: "0.01",
      filledAmount: "0.01",
      averagePrice: "100000000",
      fee: "0.000025",
      inputAsset: "USDT",
      outputAsset: "BTC",
      raw: { status: "ok" },
      createdAt: 1_300
    });
    expect(order.exchangeOrderId).toBe("order-123");
    expect(order.raw).toEqual({ status: "ok" });

    const completed = await store.completeStrategyExecution(created.id, {
      at: 1_400,
      actualOutputToman: 1_021_000,
      actualProfitToman: 21_000,
      note: "paper cycle reconciled"
    });

    expect(completed.state).toBe("CLOSED");
    expect(completed.closedAt).toBe(1_400);
    expect(completed.actualProfitToman).toBe(21_000);
    expect(completed.metadata).toEqual({ expectedEdgeBps: 250, revalidated: true });
    expect(completed.orders).toHaveLength(1);
    expect(completed.transitions.map(item => `${item.fromState}->${item.toState}`)).toEqual([
      "null->DETECTED",
      "DETECTED->REVALIDATING",
      "REVALIDATING->SUBMITTING",
      "SUBMITTING->CLOSED"
    ]);

    const history = await store.listStrategyExecutions();
    expect(history.summary.totalCount).toBe(1);
    expect(history.summary.closedCount).toBe(1);
    expect(history.summary.activeCount).toBe(0);
    expect(history.summary.totalActualProfitToman).toBe(21_000);
    expect(history.summary.byState.CLOSED).toBe(1);
  });

  test("validates transitions and refuses orders outside execution states", async () => {
    expect(store.canTransitionStrategyExecution("DETECTED", "REVALIDATING")).toBe(true);
    expect(store.canTransitionStrategyExecution("DETECTED", "SUBMITTING")).toBe(false);

    const execution = await store.createStrategyExecution({
      strategy: "statistical-pair",
      symbols: ["BTCUSDT", "ETHUSDT"],
      direction: "SHORT_BTC_LONG_ETH"
    });

    await expect(store.transitionStrategyExecution(execution.id, "SUBMITTING")).rejects.toThrow(
      "DETECTED -> SUBMITTING"
    );
    await expect(store.addStrategyExecutionOrder(execution.id, {
      legIndex: 0,
      symbol: "BTCUSDT",
      side: "SELL",
      status: "New"
    })).rejects.toThrow("is DETECTED");

    await store.transitionStrategyExecution(execution.id, "REVALIDATING");
    const failed = await store.failStrategyExecution(execution.id, "correlation regime changed", { at: 2_000 });
    expect(failed.state).toBe("FAILED_MANUAL");
    expect(failed.error).toBe("correlation regime changed");
    expect(failed.closedAt).toBe(2_000);
    await expect(store.transitionStrategyExecution(execution.id, "RECOVERING")).rejects.toThrow(
      "FAILED_MANUAL -> RECOVERING"
    );

    const history = await store.listStrategyExecutions({ state: "FAILED_MANUAL", strategy: "statistical-pair" });
    expect(history.records).toHaveLength(1);
    expect(history.summary.failedManualCount).toBe(1);
  });

  test("supports partial-fill hedging and recovery paths", async () => {
    const execution = await store.createStrategyExecution({
      strategy: "market-making",
      symbols: ["ETHUSDT"],
      direction: "TWO_SIDED"
    });
    await store.transitionStrategyExecution(execution.id, "REVALIDATING");
    await store.transitionStrategyExecution(execution.id, "SUBMITTING");
    await store.transitionStrategyExecution(execution.id, "PARTIALLY_FILLED");
    await store.addStrategyExecutionOrder(execution.id, {
      legIndex: 0,
      symbol: "ETHUSDT",
      side: "BUY",
      status: "Partial",
      requestedAmount: "1",
      filledAmount: "0.4"
    });
    await store.transitionStrategyExecution(execution.id, "HEDGING");
    await store.transitionStrategyExecution(execution.id, "RECOVERING");
    await store.transitionStrategyExecution(execution.id, "HEDGING");
    const completed = await store.completeStrategyExecution(execution.id, { actualProfitToman: -5_000 });

    expect(completed.state).toBe("CLOSED");
    expect(completed.orders[0]?.filledAmount).toBe("0.4");
    const history = await store.listStrategyExecutions();
    expect(history.summary.totalActualProfitToman).toBe(-5_000);
    expect(history.summary.partiallyFilledCount).toBe(0);
  });

  test("finds active duplicates and applies a terminal execution cooldown", async () => {
    const execution = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "imbalance:USDCUSDT",
      symbols: ["USDCUSDT"],
      direction: "LONG",
      detectedAt: 1_000
    });

    expect((await store.findRecentStrategyExecution({
      strategy: "imbalance",
      signalId: "imbalance:USDCUSDT",
      since: 2_000
    }))?.id).toBe(execution.id);

    await store.transitionStrategyExecution(execution.id, "REVALIDATING", { at: 1_100 });
    await store.transitionStrategyExecution(execution.id, "SUBMITTING", { at: 1_200 });
    await store.completeStrategyExecution(execution.id, { at: 1_300 });

    expect(await store.findRecentStrategyExecution({
      strategy: "imbalance",
      signalId: "imbalance:USDCUSDT",
      since: 1_301
    })).toBeUndefined();
    expect((await store.findRecentStrategyExecution({
      strategy: "imbalance",
      signalId: "imbalance:USDCUSDT",
      since: 1_299
    }))?.state).toBe("CLOSED");
  });

  test("atomically rejects a second active owner for the same strategy signal", async () => {
    const first = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "imbalance:BTCUSDT",
      symbols: ["BTCUSDT"],
      direction: "LONG"
    });
    await expect(store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "imbalance:BTCUSDT",
      symbols: ["BTCUSDT"],
      direction: "LONG"
    })).rejects.toMatchObject({ code: "EXECUTION_ALREADY_ACTIVE", existingExecutionId: first.id });

    await store.transitionStrategyExecution(first.id, "REVALIDATING");
    await store.failStrategyExecution(first.id, "test terminal");
    const next = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "imbalance:BTCUSDT",
      symbols: ["BTCUSDT"],
      direction: "LONG"
    });
    expect(next.id).not.toBe(first.id);
  });

  test("dashboard cleanup removes final and pre-order history but preserves exchange-facing records", async () => {
    const closed = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "closed-signal",
      symbols: ["USDCUSDT"],
      direction: "LONG"
    });
    await store.transitionStrategyExecution(closed.id, "REVALIDATING");
    await store.transitionStrategyExecution(closed.id, "SUBMITTING");
    await store.completeStrategyExecution(closed.id, { actualProfitToman: 2_000 });

    const rejected = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "preflight-rejection",
      symbols: ["BTCUSDT"],
      direction: "LONG"
    });
    await store.transitionStrategyExecution(rejected.id, "REVALIDATING");
    await store.failStrategyExecution(rejected.id, "entry cost is above the risk limit", {
      metadata: { manualInterventionRequired: false }
    });

    const staleDetected = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "abandoned-before-submit",
      symbols: ["ETHUSDT"],
      direction: "LONG",
      detectedAt: 1_000
    });

    const manualReview = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "exchange-facing-failure",
      symbols: ["DOGEUSDT"],
      direction: "LONG"
    });
    await store.transitionStrategyExecution(manualReview.id, "REVALIDATING");
    await store.transitionStrategyExecution(manualReview.id, "SUBMITTING");
    await store.addStrategyExecutionOrder(manualReview.id, {
      legIndex: 0,
      symbol: "DOGEUSDT",
      side: "BUY",
      status: "submitting",
      clientOrderId: "client-ambiguous"
    });
    await store.failStrategyExecution(manualReview.id, "exchange acknowledgement is unknown", {
      metadata: { manualInterventionRequired: true }
    });

    const active = await store.createStrategyExecution({
      strategy: "imbalance",
      signalId: "active-signal",
      symbols: ["BTCUSDT", "ETHUSDT"],
      direction: "HEDGED"
    });
    await store.transitionStrategyExecution(active.id, "REVALIDATING");
    await store.transitionStrategyExecution(active.id, "SUBMITTING");
    await store.addStrategyExecutionOrder(active.id, {
      legIndex: 0,
      symbol: "BTCUSDT",
      side: "BUY",
      status: "New",
      exchangeOrderId: "live-order"
    });

    expect(await store.clearDashboardStrategyExecutionHistory(Number.MAX_SAFE_INTEGER)).toBe(3);
    const history = await store.listStrategyExecutions();
    expect(history.records.map(record => record.id).sort()).toEqual([active.id, manualReview.id].sort());
    expect(history.records.some(record => record.id === rejected.id)).toBe(false);
    expect(history.records.some(record => record.id === staleDetected.id)).toBe(false);
    expect(history.summary.closedCount).toBe(0);
    expect(history.summary.activeCount).toBe(1);
    expect(history.summary.failedManualCount).toBe(1);
  });

  test("administrative purge removes executions, orders and transitions", async () => {
    const created = await store.createStrategyExecution({
      strategy: "imbalance",
      symbols: ["USDCUSDT"],
      direction: "LONG",
      detectedAt: 10_000
    });
    await store.transitionStrategyExecution(created.id, "REVALIDATING", { at: 10_100 });
    const deleted = await store.purgeAllStrategyExecutionData();
    expect(deleted.executions).toBe(1);
    expect(deleted.transitions).toBe(2);
    expect((await store.listStrategyExecutions()).summary.totalCount).toBe(0);
  });
});
