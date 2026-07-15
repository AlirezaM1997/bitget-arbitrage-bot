import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { defaultBotSettings } from "@/lib/bot-settings";
import type { IndependentAiMarketCandidate } from "@/lib/ai-agent/market-scanner";
import type { OrderBook } from "@/lib/exchanges/types";
import {
  createAiSpotPositionExecutionPlan,
  deserializeSpotPositionExecutionPlan,
  revalidateSpotPositionEntry,
  serializeSpotPositionExecutionPlan
} from "@/lib/strategies/spot-position-executor";
import {
  defaultSpotPositionRouteDependencies,
  handleSpotPositionRequest,
  type SpotPositionRouteDependencies
} from "@/lib/strategies/spot-position-route";

const now = 1_900_000_000_000;
const book: OrderBook = {
  symbol: "XUSDT",
  base: "X",
  quote: "USDT",
  lastUpdate: now,
  bids: [
    { price: new Decimal(99), amount: new Decimal(3_000) },
    { price: new Decimal(98), amount: new Decimal(2_000) },
    { price: new Decimal(97), amount: new Decimal(1_000) }
  ],
  asks: [
    { price: new Decimal(100), amount: new Decimal(1_000) },
    { price: new Decimal(101), amount: new Decimal(700) },
    { price: new Decimal(102), amount: new Decimal(500) }
  ]
};

function candidate(capitalToman = 10_000): IndependentAiMarketCandidate {
  return {
    id: "ai-market:XUSDT",
    kind: "autonomous-market",
    source: "independent-orderbook-scanner",
    symbol: "XUSDT",
    base: "X",
    quote: "USDT",
    direction: "LONG",
    scannedAt: now,
    bookLastUpdate: now,
    confidencePercent: 80,
    expectedEdgeBps: 100,
    estimatedNetProfitToman: 100,
    projectedMoveBps: 200,
    capitalToman,
    executable: true,
    gatePassed: true,
    blockers: [],
    reasons: ["independent raw-orderbook evidence"],
    rankScore: 90,
    features: {
      expectedEdge: 1, confidence: 0.8, orderFlow: 0.2, microprice: 0.1,
      retention: 0.8, spread: 0.1, impact: 0.1, roundTripCost: 0.2,
      persistence: 0.5, kind: 0
    },
    metrics: {
      capitalToman,
      entryAssetAmount: 100,
      immediateExitToman: 9_900,
      bestBid: 99,
      bestAsk: 100,
      midpoint: 99.5,
      microprice: 99.75,
      micropriceBiasBps: 25,
      multiLevelImbalance: 0.5,
      snapshotOrderFlow: 0.2,
      bidLiquidityRetentionPercent: 80,
      spreadBps: 100,
      entryPriceImpactBps: 0,
      exitPriceImpactBps: 0,
      maxPriceImpactBps: 0,
      roundTripCostBps: 100,
      visibleBidDepthToman: 500_000,
      visibleAskDepthToman: 200_000,
      entryDepthConsumedPercent: 1,
      exitDepthConsumedPercent: 1,
      entryAvailableInputToman: 200_000,
      exitAvailableInputAsset: 6_000,
      entryLevelsUsed: 1,
      exitLevelsUsed: 1,
      imbalanceRatio: 2.5,
      dominantTopLevelSharePercent: 50,
      bookAgeMs: 0,
      historyTransitions: 5,
      persistencePercent: 80,
      persistenceMs: 3_000
    }
  };
}

function createPlan(input = candidate()) {
  return createAiSpotPositionExecutionPlan(input, {
    capitalToman: input.capitalToman,
    tomanTakerFeeBps: 0,
    slippageBps: 0,
    liveSafetyBufferBps: 0,
    maxSpreadBps: 200,
    maxPriceImpactBps: 100,
    depthUsagePercent: 100,
    maxAgeMs: 5_000,
    orderTimeoutMs: 1_000,
    orderReserveBps: 0,
    takeProfitBps: 100,
    stopLossBps: 200,
    maxLossToman: 1_000,
    maxResidualToman: 100,
    maxHoldMs: 5_000,
    pollIntervalMs: 1_000,
    recoveryMaxSpreadBps: 1_000,
    recoveryMaxPriceImpactBps: 1_000,
    recoverySlippageBps: 100,
    imbalance: {
      levels: 3,
      levelWeightDecayPercent: 70,
      minRatio: 1.35,
      exitRatio: 1,
      minVisibleDepthToman: 10_000,
      maxTopLevelSharePercent: 100,
      minMicropriceBiasBps: 0,
      minOrderFlowImbalance: 0.02,
      minLiquidityRetentionPercent: 55
    }
  }, now);
}

describe("Autonomous AI durable Spot lifecycle", () => {
  test("persists aiAgent ownership and uses imbalance-style fresh book revalidation", () => {
    const plan = createPlan();
    expect(plan.strategy).toBe("ai-autonomous");
    expect(plan.riskStrategy).toBe("aiAgent");
    expect(plan.signalId).toBe("ai-market:XUSDT");
    expect(revalidateSpotPositionEntry(plan, [book], now).metric.gt(1.35)).toBe(true);

    const restored = deserializeSpotPositionExecutionPlan(serializeSpotPositionExecutionPlan(plan));
    expect(restored.strategy).toBe("ai-autonomous");
    expect(restored.riskStrategy).toBe("aiAgent");
    expect(Object.isFrozen(restored)).toBe(true);
  });

  test("rejects identity or capital that did not come from the final capped rescan", () => {
    expect(() => createPlan({ ...candidate(), id: "ai-market:YUSDT" })).toThrow("identity");
    expect(() => createAiSpotPositionExecutionPlan(candidate(), {
      ...planInput(), capitalToman: 9_999
    }, now)).toThrow("exact balance-capped");
  });

  test("the production route adapter maps AI-owned scanner and exit controls to aiAgent", () => {
    const settings = {
      ...defaultBotSettings,
      aiAgent: {
        ...defaultBotSettings.aiAgent,
        enabled: true,
        mode: "live" as const,
        maxLiveCapitalToman: 10_000,
        scannerLevels: 3,
        scannerMinImbalanceRatio: 1.35,
        scannerMinVisibleDepthToman: 10_000,
        scannerMaxSpreadBps: 200,
        scannerMaxPriceImpactBps: 100,
        scannerDepthUsagePercent: 100,
        scannerMaxTopLevelSharePercent: 100,
        scannerMinMicropriceBiasBps: 0
      }
    };
    const plan = defaultSpotPositionRouteDependencies.createPlan(
      "ai-autonomous",
      candidate(),
      settings,
      now
    );
    expect(plan.riskStrategy).toBe("aiAgent");
    expect(plan.config.imbalanceLevels).toBe(3);
    expect(plan.config.takeProfitBps.toNumber()).toBe(settings.aiAgent.takeProfitBps);
  });

  test("the execution endpoint cannot bypass Live mode or locally trained model qualification", async () => {
    let exchangeReads = 0;
    const demoSettings = {
      ...defaultBotSettings,
      aiAgent: { ...defaultBotSettings.aiAgent, enabled: true, mode: "demo" as const }
    };
    const demoResponse = await handleSpotPositionRequest(aiRequest(), "ai-autonomous", {
      ...defaultSpotPositionRouteDependencies,
      getSettings: async () => demoSettings,
      createClient: () => {
        exchangeReads += 1;
        throw new Error("must not create an authenticated client");
      }
    });
    expect(demoResponse.status).toBe(423);
    expect(exchangeReads).toBe(0);

    let leaseAttempts = 0;
    const liveSettings = {
      ...defaultBotSettings,
      maxTradeToman: 10_000,
      balanceUsagePercent: 100,
      aiAgent: {
        ...defaultBotSettings.aiAgent,
        enabled: true,
        mode: "live" as const,
        maxLiveCapitalToman: 10_000
      }
    };
    const dependencies: SpotPositionRouteDependencies = {
      ...defaultSpotPositionRouteDependencies,
      getSettings: async () => liveSettings,
      createClient: () => ({
        baseUrl: "https://api.bitget.com",
        getAllOrderBooks: async () => [book],
        getMarketOptions: async () => { throw new Error("unused"); },
        placeMarketOrder: async () => { throw new Error("must not place an order"); },
        getOrderStatus: async () => { throw new Error("unused"); },
        cancelOrder: async () => undefined
      }),
      getAvailableToman: async () => new Decimal(10_000),
      scan: (_kind, _books, settings) => [candidate(settings.aiAgent.maxLiveCapitalToman)],
      qualifyAiCandidate: async () => ({
        qualified: false,
        blockers: ["insufficient-training-samples"]
      }),
      acquireLease: async () => {
        leaseAttempts += 1;
        throw new Error("must not acquire a lease");
      }
    };
    const response = await handleSpotPositionRequest(aiRequest(), "ai-autonomous", dependencies);
    expect(response.status).toBe(409);
    expect((await response.json()).blockers).toEqual(["insufficient-training-samples"]);
    expect(leaseAttempts).toBe(0);
  });

  test("the server chooses a confidence-sized Live capital below the operator cap", async () => {
    const liveSettings = {
      ...defaultBotSettings,
      maxTradeToman: 2_000_000,
      balanceUsagePercent: 100,
      aiAgent: {
        ...defaultBotSettings.aiAgent,
        enabled: true,
        mode: "live" as const,
        autopilotProfile: "balanced" as const,
        maxLiveCapitalToman: 1_000_000,
        minLiveConfidencePercent: 78
      }
    };
    let plannedCapital = 0;
    const response = await handleSpotPositionRequest(aiRequest(), "ai-autonomous", {
      ...defaultSpotPositionRouteDependencies,
      apiBaseUrl: () => "https://api.bitget.com",
      getSettings: async () => liveSettings,
      createClient: () => ({
        baseUrl: "https://api.bitget.com",
        getAllOrderBooks: async () => [book],
        getMarketOptions: async () => { throw new Error("unused"); },
        placeMarketOrder: async () => { throw new Error("must not place an order"); },
        getOrderStatus: async () => { throw new Error("unused"); },
        cancelOrder: async () => undefined
      }),
      getAvailableToman: async () => new Decimal(5_000_000),
      scan: (_kind, _books, settings) => [candidate(settings.aiAgent.maxLiveCapitalToman)],
      qualifyAiCandidate: async () => ({ qualified: true, probability: 0.78, blockers: [] }),
      createPlan: (kind, signal, settings, scannedAt) => {
        plannedCapital = settings.aiAgent.maxLiveCapitalToman;
        return defaultSpotPositionRouteDependencies.createPlan(kind, signal, settings, scannedAt);
      },
      acquireLease: async () => ({
        acquired: false,
        reason: "risk-blocked",
        blockers: ["test-stop-before-order"]
      })
    });

    expect(response.status).toBe(423);
    expect(plannedCapital).toBe(350_000);
  });
});

function aiRequest() {
  return new Request("http://localhost/api/ai-agent/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin: "http://localhost",
      "x-strategy-action": "bitget-dashboard"
    },
    body: JSON.stringify({ signalId: "ai-market:XUSDT" })
  });
}

function planInput() {
  const plan = createPlan();
  return {
    capitalToman: plan.capitalToman,
    tomanTakerFeeBps: plan.config.tomanTakerFeeBps,
    slippageBps: plan.config.slippageBps,
    liveSafetyBufferBps: plan.config.liveSafetyBufferBps,
    maxSpreadBps: plan.config.maxSpreadBps,
    maxPriceImpactBps: plan.config.maxPriceImpactBps,
    depthUsagePercent: plan.config.depthUsagePercent,
    maxAgeMs: plan.config.maxAgeMs,
    orderTimeoutMs: plan.config.orderTimeoutMs,
    orderReserveBps: plan.config.orderReserveBps,
    takeProfitBps: plan.config.takeProfitBps,
    stopLossBps: plan.config.stopLossBps,
    maxLossToman: plan.config.maxLossToman,
    maxResidualToman: plan.config.maxResidualToman,
    maxHoldMs: plan.config.maxHoldMs,
    pollIntervalMs: plan.config.pollIntervalMs,
    recoveryMaxSpreadBps: plan.config.recoveryMaxSpreadBps,
    recoveryMaxPriceImpactBps: plan.config.recoveryMaxPriceImpactBps,
    recoverySlippageBps: plan.config.recoverySlippageBps,
    imbalance: {
      levels: plan.config.imbalanceLevels!,
      levelWeightDecayPercent: plan.config.imbalanceLevelWeightDecayPercent!,
      minRatio: plan.config.minImbalanceRatio!,
      exitRatio: plan.config.exitImbalanceRatio!,
      minVisibleDepthToman: plan.config.minVisibleDepthToman!,
      maxTopLevelSharePercent: plan.config.maxTopLevelSharePercent!,
      minMicropriceBiasBps: plan.config.minMicropriceBiasBps!
    }
  };
}
