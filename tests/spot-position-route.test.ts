import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { defaultBotSettings } from "@/lib/bot-settings";
import { quoteEdge } from "@/lib/bot/engine";
import type { BitgetOrder, OrderBook } from "@/lib/exchanges/types";
import { defaultRiskState } from "@/lib/risk/store";
import {
  createSpotPositionExecutionPlan,
  revalidateSpotPositionEntry,
  serializeSpotPositionExecutionPlan,
  SpotPositionExecutionError,
  type SpotPositionExecutionLeg,
  type SpotPositionExecutionPlan,
  type SpotPositionExecutionResult,
  type SpotPositionOrderRequest
} from "@/lib/strategies/spot-position-executor";
import {
  handleSpotPositionRequest,
  handleSpotPositionRecoveryRequest,
  type SpotPositionRouteDependencies
} from "@/lib/strategies/spot-position-route";
import type { StrategySignal } from "@/lib/strategies/types";

const now = 1_800_000_000_000;

function book(symbol: string, base: string, bid: number, ask: number, bidAmount = 100_000, askAmount = 100_000): OrderBook {
  return {
    symbol,
    base,
    quote: "USDT",
    lastUpdate: now,
    bids: [{ price: new Decimal(bid), amount: new Decimal(bidAmount) }],
    asks: [{ price: new Decimal(ask), amount: new Decimal(askAmount) }]
  };
}

const books = [book("XUSDT", "X", 99, 100, 300_000, 100_000)];
const signal: StrategySignal = {
  id: "imbalance:XUSDT",
  kind: "orderbook-imbalance",
  title: "X imbalance",
  symbols: ["XUSDT"],
  action: "BUY",
  status: "actionable",
  paperOnly: true,
  expectedEdgeBps: new Decimal(100),
  estimatedNetProfitToman: new Decimal(1_000),
  confidence: new Decimal(80),
  reasons: [],
  metrics: { direction: "LONG", spotExecutable: true, ratio: 3, capitalToman: 100_000, temporalConfirmed: true, spoofingGuardPassed: true, priceConfirmationPassed: true, executionDepthSafe: true },
  scannedAt: now
};

const settings = {
  ...defaultBotSettings,
  liveSafetyBufferBps: 0,
  strategyLab: {
    ...defaultBotSettings.strategyLab,
    imbalance: {
      ...defaultBotSettings.strategyLab.imbalance,
      capitalToman: 100_000,
      maxSpreadBps: 500,
      maxPriceImpactBps: 50,
      depthUsagePercent: 100,
      levels: 1,
      levelWeightDecayPercent: 70,
      minRatio: 2,
      exitRatio: 1.25,
      minVisibleDepthToman: 50_000,
      maxTopLevelSharePercent: 100,
      minMicropriceBiasBps: 0,
      takeProfitBps: 50,
      stopLossBps: 100,
      maxLossToman: 5_000,
      maxHoldMs: 5_000,
      pollIntervalMs: 1_000
    }
  }
};

function plan(capitalToman: Decimal.Value = settings.strategyLab.imbalance.capitalToman) {
  const s = settings.strategyLab.imbalance;
  return createSpotPositionExecutionPlan(signal, {
    capitalToman,
    tomanTakerFeeBps: 0,
    slippageBps: 0,
    liveSafetyBufferBps: 0,
    maxSpreadBps: s.maxSpreadBps,
    maxPriceImpactBps: s.maxPriceImpactBps,
    depthUsagePercent: s.depthUsagePercent,
    maxAgeMs: 5_000,
    orderTimeoutMs: 1_000,
    orderReserveBps: 0,
    takeProfitBps: s.takeProfitBps,
    stopLossBps: s.stopLossBps,
    maxLossToman: s.maxLossToman,
    maxResidualToman: s.maxResidualToman,
    maxHoldMs: s.maxHoldMs,
    pollIntervalMs: s.pollIntervalMs,
    recoveryMaxSpreadBps: s.recoveryMaxSpreadBps,
    recoveryMaxPriceImpactBps: s.recoveryMaxPriceImpactBps,
    recoverySlippageBps: s.recoverySlippageBps,
    imbalance: { levels: s.levels, levelWeightDecayPercent: s.levelWeightDecayPercent, minRatio: s.minRatio, exitRatio: s.exitRatio, minVisibleDepthToman: s.minVisibleDepthToman, maxTopLevelSharePercent: s.maxTopLevelSharePercent, minMicropriceBiasBps: s.minMicropriceBiasBps }
  }, now);
}

function request(body: unknown, path = "execute", origin = "http://localhost") {
  return new Request(`http://localhost/api/strategies/orderbook-imbalance/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin, "x-strategy-action": "bitget-dashboard" },
    body: JSON.stringify(body)
  });
}

function dependencies(overrides: Partial<SpotPositionRouteDependencies> = {}): SpotPositionRouteDependencies {
  const riskState = defaultRiskState(now);
  riskState.strategies.imbalance.enabled = true;
  riskState.strategies.imbalance.readiness = {
    positionStateReady: true,
    recoveryReady: true,
    executionAdapterReady: true
  };
  const base: SpotPositionRouteDependencies = {
    getSettings: async () => settings,
    apiBaseUrl: () => "https://api.bitget.com",
    createClient: () => ({
      baseUrl: "https://api.bitget.com",
      getAllOrderBooks: async () => books,
      getMarketOptions: async () => { throw new Error("unused"); },
      placeMarketOrder: async () => { throw new Error("unused"); },
      getOrderStatus: async () => { throw new Error("unused"); },
      cancelOrder: async () => { throw new Error("unused"); }
    }),
    getAvailableToman: async () => new Decimal(1_000_000),
    scan: () => [signal],
    createPlan: () => plan(),
    acquireLease: async () => ({ acquired: true, lease: lease("execution") }),
    acquireRecoveryLease: async () => ({ acquired: true, lease: { ...lease("execution"), purpose: "recovery" as const } }),
    acquireRecordLock: async ({ executionId, owner }) => ({ acquired: true, lock: {
      version: 1 as const,
      executionId,
      owner,
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000099",
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 310_000).toISOString()
    } }),
    releaseRecordLock: async () => true,
    recordPnl: async () => riskState,
    renewLease: async () => true,
    releaseLease: async () => true,
    getRiskState: async () => riskState,
    evaluateRisk: () => ({
      canExecute: true,
      dailyLossBreached: false,
      globalBlockers: [],
      strategies: {
        triangle: status(), gapTrading: status(), imbalance: status(), aiAgent: status()
      }
    }),
    emergencyStop: async () => riskState,
    createExecution: async () => ({ id: 9 }) as never,
    transitionExecution: async () => ({ id: 9 }) as never,
    addOrder: async () => ({ id: 1 }) as never,
    completeExecution: async () => ({ id: 9 }) as never,
    failExecution: async () => ({ id: 9 }) as never,
    listExecutions: async () => ({ records: [], summary: {} }) as never,
    execute: async p => completed(p),
    recover: async () => { throw new Error("unused"); },
    now: () => now,
    randomId: () => "route-test"
  };
  return { ...base, ...overrides };
}

function status() { return { enabled: true, ready: true, canExecute: true, blockers: [] }; }
function lease(purpose: "execution") {
  return {
    version: 1 as const,
    slot: 0,
    strategy: "imbalance" as const,
    purpose,
    owner: "test",
    token: "00000000-0000-4000-8000-000000000001",
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString()
  };
}

function order(id: string, amount: Decimal.Value, price: Decimal.Value): BitgetOrder {
  const matched = new Decimal(amount);
  return {
    id,
    status: "Done",
    amount: matched,
    matchedAmount: matched,
    unmatchedAmount: new Decimal(0),
    totalPrice: matched.mul(price).mul(10),
    averagePrice: new Decimal(price).mul(10),
    fee: new Decimal(0),
    raw: { id }
  };
}

function leg(stage: "entry" | "exit", side: "BUY" | "SELL", amount: Decimal.Value, input: Decimal.Value, output: Decimal.Value): SpotPositionExecutionLeg {
  return {
    stage,
    symbol: "XUSDT",
    side,
    orderId: `${stage}-exchange-id`,
    clientOrderId: `${stage}-client-id`,
    status: "Done",
    submittedAmountBase: new Decimal(amount),
    matchedAmountBase: new Decimal(amount),
    unmatchedAmountBase: new Decimal(0),
    actualInput: new Decimal(input),
    inputAsset: side === "BUY" ? "USDT" : "X",
    actualOutput: new Decimal(output),
    outputAsset: side === "BUY" ? "X" : "USDT",
    fee: new Decimal(0),
    feeAsset: side === "BUY" ? "X" : "USDT",
    averagePrice: new Decimal(side === "BUY" ? 91 : 101),
    fullFill: true
  };
}

function completed(p: SpotPositionExecutionPlan): SpotPositionExecutionResult {
  return {
    status: "completed",
    plan: p,
    entryValidation: revalidateSpotPositionEntry(p, books, now),
    legs: [leg("entry", "BUY", 1_000, 91_000, 1_000), leg("exit", "SELL", 1_000, 1_000, 101_000)],
    exitReason: "take-profit",
    inputToman: new Decimal(91_000),
    outputToman: new Decimal(101_000),
    profitToman: new Decimal(10_000),
    profitBps: new Decimal("1098.9010989"),
    residualAssetAmount: new Decimal(0),
    heldMs: 1_000
  };
}

describe("Orderbook Imbalance route safety contract", () => {
  test("rejects foreign origin and browser-supplied capital", async () => {
    expect((await handleSpotPositionRequest(request({ signalId: signal.id }, "execute", "https://evil.example"), "orderbook-imbalance", dependencies())).status).toBe(403);
    const response = await handleSpotPositionRequest(request({ signalId: signal.id, capitalToman: 1 }), "orderbook-imbalance", dependencies());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("only signalId");
  });

  test("blocks non-Mainnet environments before settings, scans, leases or exchange reads", async () => {
    const calls = { settings: 0, reads: 0, lease: 0 };
    const response = await handleSpotPositionRequest(request({ signalId: signal.id }), "orderbook-imbalance", dependencies({
      apiBaseUrl: () => "https://example.invalid",
      getSettings: async () => { calls.settings += 1; return settings; },
      createClient: () => ({
        getAllOrderBooks: async () => { calls.reads += 1; return books; },
        getMarketOptions: async () => { throw new Error("unused"); }, placeMarketOrder: async () => { throw new Error("unused"); },
        getOrderStatus: async () => { throw new Error("unused"); }, cancelOrder: async () => undefined
      }),
      acquireLease: async () => { calls.lease += 1; return { acquired: true, lease: lease("execution") }; }
    }));
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ code: "MAINNET_REQUIRED" });
    expect(calls).toEqual({ settings: 0, reads: 0, lease: 0 });
  });

  test("rescans by signalId and rejects a stale/non-actionable signal before a lease", async () => {
    let leases = 0;
    const response = await handleSpotPositionRequest(request({ signalId: signal.id }), "orderbook-imbalance", dependencies({
      scan: () => [],
      acquireLease: async () => { leases += 1; return { acquired: true, lease: lease("execution") }; }
    }));
    expect(response.status).toBe(409);
    expect(leases).toBe(0);
  });

  test("caps entry capital by strategy, global trade limit and usable free Spot USDT", async () => {
    const cappedSettings = {
      ...settings,
      maxTradeToman: 80_000,
      balanceUsagePercent: 25,
      strategyLab: {
        ...settings.strategyLab,
        imbalance: { ...settings.strategyLab.imbalance, capitalToman: 100_000 }
      }
    };
    let scanCapital = 0;
    let planCapital = 0;
    let recordedCapital = 0;
    const response = await handleSpotPositionRequest(request({ signalId: signal.id }), "orderbook-imbalance", dependencies({
      getSettings: async () => cappedSettings,
      // 25% of 200,000 = 50,000, which is below both configured caps.
      getAvailableToman: async () => new Decimal(200_000),
      scan: (_kind, _books, receivedSettings) => {
        scanCapital = receivedSettings.strategyLab.imbalance.capitalToman;
        return [signal];
      },
      createPlan: (_kind, _signal, receivedSettings) => {
        planCapital = receivedSettings.strategyLab.imbalance.capitalToman;
        return plan(planCapital);
      },
      createExecution: async input => {
        recordedCapital = input.requestedCapitalToman ?? 0;
        return { id: 9 } as never;
      }
    }));

    expect(response.status).toBe(200);
    expect({ scanCapital, planCapital, recordedCapital }).toEqual({
      scanCapital: 50_000,
      planCapital: 50_000,
      recordedCapital: 50_000
    });
  });

  test("persists entry/position/exit lifecycle and both client/exchange order ids", async () => {
    const transitions: string[] = [];
    const storedOrders: Array<Record<string, unknown>> = [];
    let pnlIdempotencyKey = "";
    let released = 0;
    const response = await handleSpotPositionRequest(request({ signalId: signal.id }), "orderbook-imbalance", dependencies({
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 9 } as never; },
      addOrder: async (_id, value) => { storedOrders.push(value as unknown as Record<string, unknown>); return { id: storedOrders.length } as never; },
      completeExecution: async () => { transitions.push("CLOSED"); return { id: 9 } as never; },
      recordPnl: async (_pnl, _at, idempotency) => {
        pnlIdempotencyKey = typeof idempotency === "object" ? idempotency.idempotencyKey ?? "" : "";
        return defaultRiskState(now);
      },
      releaseLease: async () => { released += 1; return true; },
      execute: async (p, _client, hooks) => {
        const validation = revalidateSpotPositionEntry(p, books, now);
        const entryRequest: SpotPositionOrderRequest = { side: "BUY", base: "X", quote: "USDT", amountBase: new Decimal(1_000), expectedPrice: new Decimal(100), clientOrderId: "entry-client-id" };
        const entryOrder = order("entry-exchange-id", 1_000, 91);
        const entryLeg = leg("entry", "BUY", 1_000, 91_000, 1_000);
        await hooks.onBeforeOrder?.({ stage: "entry", plan: p, quote: validation.entryQuote, request: entryRequest });
        await hooks.onOrderSubmitted?.({ stage: "entry", plan: p, order: entryOrder, request: entryRequest });
        await hooks.onOrderFinalized?.({ stage: "entry", plan: p, leg: entryLeg });
        await hooks.onPositionOpened?.({ plan: p, entry: entryLeg });
        await hooks.onPositionCheck?.({ plan: p, heldMs: 1_000 });
        const exitQuote = quoteEdge({ id: "XUSDT:SELL", from: "X", to: "USDT", side: "SELL", book: books[0]! }, 1_000, 0, 0, 100)!;
        const exitRequest: SpotPositionOrderRequest = { side: "SELL", base: "X", quote: "USDT", amountBase: new Decimal(1_000), expectedPrice: new Decimal(99), clientOrderId: "exit-client-id" };
        const exitOrder = order("exit-exchange-id", 1_000, 101);
        const exitLeg = leg("exit", "SELL", 1_000, 1_000, 101_000);
        await hooks.onBeforeOrder?.({ stage: "exit", plan: p, quote: exitQuote, request: exitRequest });
        await hooks.onOrderSubmitted?.({ stage: "exit", plan: p, order: exitOrder, request: exitRequest });
        await hooks.onOrderFinalized?.({ stage: "exit", plan: p, leg: exitLeg });
        return { ...completed(p), entryValidation: validation, legs: [entryLeg, exitLeg] };
      }
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", strategy: "imbalance", pnlRecordedGlobally: true });
    expect(transitions).toEqual(["REVALIDATING", "SUBMITTING", "HEDGING", "CLOSED"]);
    expect(storedOrders.some(value => value.clientOrderId === "entry-client-id" && value.exchangeOrderId === "entry-exchange-id")).toBe(true);
    expect(storedOrders.some(value => value.clientOrderId === "exit-client-id" && value.exchangeOrderId === "exit-exchange-id")).toBe(true);
    expect(pnlIdempotencyKey).toBe("spot:9:pnl");
    expect(released).toBe(1);
  });

  test("ambiguous exposed state fails manual, triggers emergency stop and releases the lease", async () => {
    let emergency = 0;
    let failed = 0;
    let released = 0;
    const response = await handleSpotPositionRequest(request({ signalId: signal.id }), "orderbook-imbalance", dependencies({
      execute: async (p, _client, hooks) => {
        const validation = revalidateSpotPositionEntry(p, books, now);
        const request: SpotPositionOrderRequest = { side: "BUY", base: "X", quote: "USDT", amountBase: new Decimal(1_000), expectedPrice: new Decimal(100), clientOrderId: "ambiguous" };
        await hooks.onBeforeOrder?.({ stage: "entry", plan: p, quote: validation.entryQuote, request });
        await hooks.onOrderSubmitted?.({ stage: "entry", plan: p, order: order("maybe-filled", 1_000, 91), request });
        throw new SpotPositionExecutionError("unknown final order state", "ORDER_STATE_UNKNOWN", true);
      },
      failExecution: async () => { failed += 1; return { id: 9 } as never; },
      emergencyStop: async () => { emergency += 1; return defaultRiskState(now); },
      releaseLease: async () => { released += 1; return true; }
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ORDER_STATE_UNKNOWN", manualInterventionRequired: true });
    expect({ emergency, failed, released }).toEqual({ emergency: 1, failed: 1, released: 1 });
  });

  test("a valuable untradable residual never closes the record or records false realized PnL", async () => {
    const calls = { completed: 0, pnl: 0, failed: 0, emergency: 0 };
    const response = await handleSpotPositionRequest(request({ signalId: signal.id }), "orderbook-imbalance", dependencies({
      execute: async (p, _client, hooks) => {
        const entryLeg = leg("entry", "BUY", 1_000, 91_000, 999.995);
        await hooks.onPositionOpened?.({ plan: p, entry: entryLeg });
        throw new SpotPositionExecutionError(
          "exit left valuable asset exposure and PnL is not realized",
          "UNTRADABLE_RESIDUAL",
          true
        );
      },
      completeExecution: async () => { calls.completed += 1; return { id: 9 } as never; },
      recordPnl: async () => { calls.pnl += 1; return defaultRiskState(now); },
      failExecution: async () => { calls.failed += 1; return { id: 9 } as never; },
      emergencyStop: async () => { calls.emergency += 1; return defaultRiskState(now); }
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "UNTRADABLE_RESIDUAL", manualInterventionRequired: true, retryScheduled: false });
    expect(calls).toEqual({ completed: 0, pnl: 0, failed: 1, emergency: 1 });
  });

  test("an in-request recovery liquidity gap remains durable and retryable", async () => {
    let failed = 0;
    let emergency = 0;
    const transitions: string[] = [];
    const response = await handleSpotPositionRequest(request({ signalId: signal.id }), "orderbook-imbalance", dependencies({
      execute: async (p, _client, hooks) => {
        const validation = revalidateSpotPositionEntry(p, books, now);
        const entryRequest: SpotPositionOrderRequest = { side: "BUY", base: "X", quote: "USDT", amountBase: new Decimal(1_000), expectedPrice: new Decimal(100), clientOrderId: "known-entry" };
        await hooks.onBeforeOrder?.({ stage: "entry", plan: p, quote: validation.entryQuote, request: entryRequest });
        await hooks.onOrderSubmitted?.({ stage: "entry", plan: p, order: order("known-filled", 1_000, 91), request: entryRequest });
        throw new SpotPositionExecutionError("temporary recovery depth gap", "RECOVERY_FAILED", true);
      },
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 9 } as never; },
      failExecution: async () => { failed += 1; return { id: 9 } as never; },
      emergencyStop: async () => { emergency += 1; return defaultRiskState(now); }
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "RECOVERY_FAILED", retryScheduled: true, manualInterventionRequired: false });
    expect(transitions).toContain("RECOVERING");
    expect(failed).toBe(0);
    expect(emergency).toBe(1);
  });

  test("restart recovery reconciles persisted exchange ids and uses only a Recovery Lease to SELL to USDT", async () => {
    const transitions: string[] = [];
    let entryLeases = 0;
    let recoveryLeases = 0;
    let recoveredAmount = "";
    let pnlIdempotencyKey = "";
    const activeRecord = {
      id: 41,
      strategy: "imbalance",
      signalId: signal.id,
      state: "HEDGING",
      symbols: signal.symbols,
      direction: "USDT -> asset -> USDT (long Spot)",
      metadata: { executionPlan: serializeSpotPositionExecutionPlan(plan()) },
      orders: [{
        id: 1, executionId: 41, legIndex: 0, symbol: "XUSDT", side: "BUY", orderType: "MARKET", status: "Done",
        clientOrderId: "entry-client", exchangeOrderId: "entry-exchange", requestedAmount: "1000", filledAmount: "1000",
        averagePrice: "100", fee: "0", inputAsset: "USDT", outputAsset: "X", raw: {}, createdAt: now
      }]
    };
    const response = await handleSpotPositionRecoveryRequest(request({ signalId: signal.id }, "recover"), "orderbook-imbalance", dependencies({
      listExecutions: async () => ({ records: [activeRecord] }) as never,
      acquireLease: async () => { entryLeases += 1; return { acquired: true, lease: lease("execution") }; },
      acquireRecoveryLease: async () => {
        recoveryLeases += 1;
        return { acquired: true, lease: { ...lease("execution"), purpose: "recovery" as const } };
      },
      createClient: () => ({
        baseUrl: "https://api.bitget.com",
        getAllOrderBooks: async () => books,
        getMarketOptions: async () => { throw new Error("unused"); },
        placeMarketOrder: async () => { throw new Error("unused"); },
        getOrderStatus: async id => {
          expect(id).toBe("entry-exchange");
          return order(id, 1_000, 91);
        },
        cancelOrder: async () => { throw new Error("terminal order must not be canceled"); }
      }),
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 41 } as never; },
      completeExecution: async () => { transitions.push("CLOSED"); return { id: 41 } as never; },
      recordPnl: async (_pnl, _at, idempotency) => {
        pnlIdempotencyKey = typeof idempotency === "object" ? idempotency.idempotencyKey ?? "" : "";
        return defaultRiskState(now);
      },
      recover: async (p, amount, _client, hooks) => {
        recoveredAmount = new Decimal(amount).toString();
        const quote = quoteEdge({ id: "XUSDT:SELL", from: "X", to: "USDT", side: "SELL", book: books[0]! }, amount, 0, 0, 100)!;
        const recoveryRequest: SpotPositionOrderRequest = { side: "SELL", base: "X", quote: "USDT", amountBase: new Decimal(amount), expectedPrice: new Decimal(99), clientOrderId: "recovery-client" };
        const recoveryOrder = order("recovery-exchange", amount, 90);
        const recoveryLeg = { ...leg("exit", "SELL", amount, amount, new Decimal(amount).mul(90)), stage: "recovery" as const, orderId: "recovery-exchange", clientOrderId: "recovery-client" };
        await hooks.onBeforeOrder?.({ stage: "recovery", plan: p, quote, request: recoveryRequest });
        await hooks.onOrderSubmitted?.({ stage: "recovery", plan: p, order: recoveryOrder, request: recoveryRequest });
        await hooks.onOrderFinalized?.({ stage: "recovery", plan: p, leg: recoveryLeg });
        return { plan: p, leg: recoveryLeg, recoveredToman: recoveryLeg.actualOutput, residualAssetAmount: new Decimal(0) };
      }
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "recovered", executionId: 41, residualAssetAmount: "0" });
    expect(entryLeases).toBe(0);
    expect(recoveryLeases).toBe(1);
    expect(recoveredAmount).toBe("1000");
    expect(pnlIdempotencyKey).toBe("spot:41:pnl");
    expect(transitions).toEqual(["RECOVERING", "CLOSED"]);
  });

  test("already-flat recovery records PnL once under the persisted execution key", async () => {
    let recoveryOrders = 0;
    let pnlIdempotencyKey = "";
    const activeRecord = {
      id: 46,
      strategy: "imbalance",
      signalId: signal.id,
      state: "HEDGING",
      symbols: signal.symbols,
      direction: "USDT -> asset -> USDT (long Spot)",
      metadata: { executionPlan: serializeSpotPositionExecutionPlan(plan()) },
      orders: [
        { clientOrderId: "flat-entry-client", exchangeOrderId: "flat-entry", side: "BUY" },
        { clientOrderId: "flat-exit-client", exchangeOrderId: "flat-exit", side: "SELL" }
      ]
    };
    const response = await handleSpotPositionRecoveryRequest(request({ signalId: signal.id }, "recover"), "orderbook-imbalance", dependencies({
      listExecutions: async () => ({ records: [activeRecord] }) as never,
      createClient: () => ({
        baseUrl: "https://api.bitget.com",
        getAllOrderBooks: async () => books,
        getMarketOptions: async () => { throw new Error("unused"); },
        placeMarketOrder: async () => { throw new Error("unused"); },
        getOrderStatus: async id => order(id, 1_000, id === "flat-entry" ? 91 : 101),
        cancelOrder: async () => { throw new Error("terminal orders must not be canceled"); }
      }),
      recover: async () => {
        recoveryOrders += 1;
        throw new Error("an already-flat position must not submit another SELL");
      },
      recordPnl: async (_pnl, _at, idempotency) => {
        pnlIdempotencyKey = typeof idempotency === "object" ? idempotency.idempotencyKey ?? "" : "";
        return defaultRiskState(now);
      }
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "already-flat", executionId: 46, exposureAmount: "0" });
    expect(recoveryOrders).toBe(0);
    expect(pnlIdempotencyKey).toBe("spot:46:pnl");
  });

  test("restart recovery never guesses exposure when a client id has no exchange order id", async () => {
    let recoveryOrders = 0;
    let emergency = 0;
    const activeRecord = {
      id: 42,
      strategy: "imbalance",
      signalId: signal.id,
      state: "SUBMITTING",
      symbols: signal.symbols,
      direction: "USDT -> asset -> USDT (long Spot)",
      metadata: { executionPlan: serializeSpotPositionExecutionPlan(plan()) },
      orders: [{ clientOrderId: "ambiguous-client", exchangeOrderId: null, side: "BUY" }]
    };
    const response = await handleSpotPositionRecoveryRequest(request({ signalId: signal.id }, "recover"), "orderbook-imbalance", dependencies({
      listExecutions: async () => ({ records: [activeRecord] }) as never,
      recover: async () => { recoveryOrders += 1; throw new Error("must not recover"); },
      emergencyStop: async () => { emergency += 1; return defaultRiskState(now); }
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ORDER_STATE_UNKNOWN", manualInterventionRequired: true });
    expect(recoveryOrders).toBe(0);
    expect(emergency).toBe(1);
  });

  test("restart recovery resolves a persisted submit intent through clientOrderId lookup", async () => {
    let recoveredAmount = "";
    const activeRecord = {
      id: 45,
      strategy: "imbalance",
      signalId: signal.id,
      state: "SUBMITTING",
      symbols: signal.symbols,
      direction: "USDT -> asset -> USDT (long Spot)",
      metadata: { executionPlan: serializeSpotPositionExecutionPlan(plan()) },
      orders: [{ clientOrderId: "accepted-after-timeout", exchangeOrderId: null, side: "BUY" }]
    };
    const response = await handleSpotPositionRecoveryRequest(request({ signalId: signal.id }, "recover"), "orderbook-imbalance", dependencies({
      listExecutions: async () => ({ records: [activeRecord] }) as never,
      createClient: () => ({
        baseUrl: "https://api.bitget.com",
        getAllOrderBooks: async () => books,
        getMarketOptions: async () => { throw new Error("unused"); },
        placeMarketOrder: async () => { throw new Error("unused"); },
        getOrderStatusByClientOrderId: async id => {
          expect(id).toBe("accepted-after-timeout");
          return order("resolved-entry", 1_000, 91);
        },
        getOrderStatus: async id => {
          expect(id).toBe("resolved-entry");
          return order(id, 1_000, 91);
        },
        cancelOrder: async () => { throw new Error("terminal order must not be canceled"); }
      }),
      recover: async (p, amount) => {
        recoveredAmount = new Decimal(amount).toString();
        const recoveryLeg = {
          ...leg("exit", "SELL", amount, amount, new Decimal(amount).mul(90)),
          stage: "recovery" as const,
          orderId: "resolved-recovery",
          clientOrderId: "resolved-recovery-client"
        };
        return { plan: p, leg: recoveryLeg, recoveredToman: recoveryLeg.actualOutput, residualAssetAmount: new Decimal(0) };
      }
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "recovered", executionId: 45, residualAssetAmount: "0" });
    expect(recoveredAmount).toBe("1000");
  });

  test("record fencing blocks recovery while the original position worker owns it", async () => {
    let recoveryLeases = 0;
    const activeRecord = {
      id: 43,
      strategy: "imbalance",
      signalId: signal.id,
      state: "HEDGING",
      symbols: signal.symbols,
      direction: "USDT -> asset -> USDT (long Spot)",
      metadata: { executionPlan: serializeSpotPositionExecutionPlan(plan()) },
      orders: []
    };
    const response = await handleSpotPositionRecoveryRequest(request({ signalId: signal.id }, "recover"), "orderbook-imbalance", dependencies({
      listExecutions: async () => ({ records: [activeRecord] }) as never,
      acquireRecordLock: async () => ({ acquired: false }),
      acquireRecoveryLease: async () => {
        recoveryLeases += 1;
        return { acquired: true, lease: { ...lease("execution"), purpose: "recovery" as const } };
      }
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "busy", code: "POSITION_ALREADY_OWNED" });
    expect(recoveryLeases).toBe(0);
  });

  test("keeps transient liquidity recovery failures retryable instead of terminal", async () => {
    let failed = 0;
    let emergency = 0;
    const activeRecord = {
      id: 44,
      strategy: "imbalance",
      signalId: signal.id,
      state: "HEDGING",
      symbols: signal.symbols,
      direction: "USDT -> asset -> USDT (long Spot)",
      metadata: { executionPlan: serializeSpotPositionExecutionPlan(plan()) },
      orders: [{ clientOrderId: "entry-client", exchangeOrderId: "entry-exchange", side: "BUY" }]
    };
    const response = await handleSpotPositionRecoveryRequest(request({ signalId: signal.id }, "recover"), "orderbook-imbalance", dependencies({
      listExecutions: async () => ({ records: [activeRecord] }) as never,
      createClient: () => ({
        baseUrl: "https://api.bitget.com",
        getAllOrderBooks: async () => books,
        getMarketOptions: async () => { throw new Error("unused"); },
        placeMarketOrder: async () => { throw new Error("unused"); },
        getOrderStatus: async () => order("entry-exchange", 1_000, 91),
        cancelOrder: async () => undefined
      }),
      recover: async () => { throw new SpotPositionExecutionError("temporary depth gap", "RECOVERY_FAILED", true); },
      failExecution: async () => { failed += 1; return { id: 44 } as never; },
      emergencyStop: async () => { emergency += 1; return defaultRiskState(now); }
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "RECOVERY_FAILED", retryScheduled: true, manualInterventionRequired: false });
    expect(failed).toBe(0);
    expect(emergency).toBe(1);
  });
});
