import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Decimal from "decimal.js";
import {
  AI_FEATURE_NAMES,
  createDefaultAiModel,
  extractAiFeatures,
  predictAiProbability,
  updateAiModel
} from "@/lib/ai-agent/model";
import {
  AI_AGENT_MAX_DECISIONS,
  AI_AGENT_MAX_RECENT_TRADES,
  appendAiDecision,
  createDefaultAiAgentState,
  mutateAiAgentState,
  readAiAgentState,
  resetAiAgentState
} from "@/lib/ai-agent/store";
import type { AiDecision, AiDemoTrade, AiFeatures } from "@/lib/ai-agent/types";
import type { StrategySignal } from "@/lib/strategies/types";
import { defaultBotSettings } from "@/lib/bot-settings";
import { runAiDemoCycle } from "@/lib/ai-agent/demo";
import { selectAiLiveSignal } from "@/lib/ai-agent/live-policy";
import type { OrderBook } from "@/lib/exchanges/types";
import type { IndependentAiMarketCandidate } from "@/lib/ai-agent/market-scanner";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "bitget-ai-agent-"));
  process.env.AI_AGENT_STATE_PATH = path.join(directory, "state.json");
});

afterEach(async () => {
  delete process.env.AI_AGENT_STATE_PATH;
  await rm(directory, { recursive: true, force: true });
});

describe("AI agent numerical model", () => {
  test("extracts a fixed bounded feature contract and predicts deterministically", () => {
    const signal: StrategySignal = {
      id: "imbalance:BTCUSDT",
      kind: "orderbook-imbalance",
      title: "BTC imbalance",
      symbols: ["BTCUSDT"],
      action: "Long",
      status: "actionable",
      paperOnly: true,
      expectedEdgeBps: new Decimal(250),
      estimatedNetProfitToman: new Decimal(10_000),
      confidence: new Decimal(80),
      reasons: [],
      metrics: {
        normalizedOrderFlow: 0.25,
        micropriceBiasBps: 5,
        dominantLiquidityRetentionPercent: 75,
        spreadBps: 20,
        priceImpactBps: 30,
        exitPriceImpactBps: 40,
        projectedRoundTripCostBps: 50,
        persistenceMs: 5_000
      },
      scannedAt: 1_000
    };
    const features = extractAiFeatures(signal);
    expect(Object.keys(features)).toEqual([...AI_FEATURE_NAMES]);
    expect(features).toEqual({
      expectedEdge: 2.5,
      confidence: 0.8,
      orderFlow: 0.25,
      microprice: 0.5,
      retention: 0.75,
      spread: 0.2,
      impact: 0.4,
      roundTripCost: 0.5,
      persistence: 0.5,
      kind: 1
    });
    const model = createDefaultAiModel();
    expect(predictAiProbability(model, features)).toBe(0.5);
    expect(predictAiProbability(model, features)).toBe(0.5);
  });

  test("records prequential quality before a bounded logistic update", () => {
    const features = allFeatures(1);
    const initial = createDefaultAiModel();
    const update = updateAiModel(initial, features, 0.5, 1, 10, 100);
    expect(update.trainingSamples).toBe(1);
    expect(update.correctPredictions).toBe(1);
    expect(update.brierScoreSum).toBe(0.25);
    expect(update.modelVersion).toBe(2);
    expect(predictAiProbability(update, features)).toBeGreaterThan(0.5);

    let model = initial;
    for (let index = 0; index < 1_000; index += 1) {
      model = updateAiModel(model, allFeatures(5), 0, 1, 100, 10_000);
    }
    expect(model.bias).toBe(8);
    expect(Math.max(...Object.values(model.weights))).toBe(8);
  });
});

describe("AI agent file state store", () => {
  test("creates a safe default and reset restores the requested capital", async () => {
    const state = await readAiAgentState(1_000_000);
    expect(state).toEqual(createDefaultAiAgentState(1_000_000, state.updatedAt));
    expect(JSON.parse(await readFile(process.env.AI_AGENT_STATE_PATH!, "utf8")).version).toBe(1);

    await mutateAiAgentState(1_000_000, draft => {
      draft.model.trainingSamples = 12;
      draft.model.correctPredictions = 7;
      draft.demo.cashToman = 900_000;
    });
    const reset = await resetAiAgentState(2_000_000);
    expect(reset.model.trainingSamples).toBe(0);
    expect(reset.demo.initialCapitalToman).toBe(2_000_000);
    expect(reset.demo.cashToman).toBe(2_000_000);
  });

  test("migrates a partial v1 state and fills every fixed model weight", async () => {
    await writeFile(process.env.AI_AGENT_STATE_PATH!, JSON.stringify({
      version: 1,
      model: {
        weights: { expectedEdge: 2 },
        bias: 0.25,
        trainingSamples: 4,
        correctPredictions: 3,
        brierScoreSum: 0.5,
        modelVersion: 5
      },
      demo: { initialCapitalToman: 500_000, cashToman: 450_000 },
      updatedAt: 123
    }));
    const state = await readAiAgentState(1_000_000);
    expect(state.model.weights.expectedEdge).toBe(2);
    expect(state.model.weights.confidence).toBe(0);
    expect(Object.keys(state.model.weights)).toEqual([...AI_FEATURE_NAMES]);
    expect(state.demo.initialCapitalToman).toBe(500_000);
    expect(state.demo.openPositions).toEqual([]);
    expect(state.decisions).toEqual([]);
  });

  test("bounds decisions and recent Demo trades", async () => {
    let state = createDefaultAiAgentState(1_000_000, 0);
    for (let index = 0; index < AI_AGENT_MAX_DECISIONS + 25; index += 1) {
      appendAiDecision(state, decision(index));
    }
    expect(state.decisions).toHaveLength(AI_AGENT_MAX_DECISIONS);
    expect(state.decisions[0]?.id).toBe("decision-25");

    const stored = await mutateAiAgentState(1_000_000, draft => {
      draft.decisions = state.decisions;
      draft.demo.recentTrades = Array.from(
        { length: AI_AGENT_MAX_RECENT_TRADES + 20 },
        (_, index) => trade(index)
      );
    });
    expect(stored.demo.recentTrades).toHaveLength(AI_AGENT_MAX_RECENT_TRADES);
    expect(stored.demo.recentTrades[0]?.id).toBe("trade-20");
  });

  test("serializes concurrent mutations without dropping updates", async () => {
    await resetAiAgentState(1_000_000);
    await Promise.all(Array.from({ length: 20 }, () => mutateAiAgentState(1_000_000, draft => {
      draft.model.trainingSamples += 1;
    })));
    expect((await readAiAgentState(1_000_000)).model.trainingSamples).toBe(20);
  });
});

describe("AI agent Demo broker and Live policy", () => {
  test("opens and closes a depth-priced Demo position before training the model", async () => {
    const settings = {
      ...defaultBotSettings,
      tomanTakerFeeBps: 0,
      slippageBufferBps: 0,
      maxSpreadBps: 200,
      aiAgent: {
        ...defaultBotSettings.aiAgent,
        enabled: true,
        demoCapitalToman: 1_000_000,
        demoTradeCapitalToman: 100_000,
        takeProfitBps: 100,
        cooldownMs: 60_000
      }
    };
    const candidate = aiCandidate(100_000);
    const opened = await runAiDemoCycle({ books: [book(99, 100, 1_000)], candidates: [candidate], settings, now: 1_000 });
    expect(opened.opened).toBe(1);
    let state = await readAiAgentState(1_000_000);
    expect(state.demo.openPositions).toHaveLength(1);
    expect(state.demo.openPositions[0]!.inputToman).toBeGreaterThan(0);
    expect(state.demo.openPositions[0]!.inputToman).toBeLessThanOrEqual(100_000);
    expect(state.demo.cashToman).toBe(1_000_000 - state.demo.openPositions[0]!.inputToman);
    expect(state.model.trainingSamples).toBe(0);

    const closed = await runAiDemoCycle({ books: [book(110, 111, 31_000)], candidates: [], settings, now: 31_000 });
    expect(closed.closed).toBe(1);
    state = await readAiAgentState(1_000_000);
    expect(state.demo.openPositions).toHaveLength(0);
    expect(state.demo.recentTrades).toHaveLength(1);
    expect(state.demo.recentTrades[0]!.pnlToman).toBeGreaterThan(0);
    expect(state.model.trainingSamples).toBe(1);
    expect(state.model.correctPredictions).toBe(1);
  });

  test("keeps edge-only learning cash-neutral without blocking a valid Demo entry", async () => {
    const settings = {
      ...defaultBotSettings,
      tomanTakerFeeBps: 0,
      slippageBufferBps: 0,
      maxSpreadBps: 200,
      aiAgent: {
        ...defaultBotSettings.aiAgent,
        enabled: true,
        demoCapitalToman: 1_000_000,
        demoTradeCapitalToman: 100_000,
        takeProfitBps: 100,
        stopLossBps: 1_000,
        maxHoldMs: 120_000,
        cooldownMs: 60_000
      }
    };
    const candidate = {
      ...aiCandidate(100_000),
      gatePassed: false,
      blockers: ["edge-below-threshold" as const],
      expectedEdgeBps: -25
    };

    const opened = await runAiDemoCycle({
      books: [book(99, 100, 1_000)],
      candidates: [candidate],
      settings,
      now: 1_000
    });
    expect(opened.detail).toBe("demo-shadow-position-opened");
    let state = await readAiAgentState(1_000_000);
    expect(state.demo.openPositions[0]?.learningOnly).toBe(true);
    expect(state.demo.cashToman).toBe(1_000_000);
    expect(state.demo.peakEquityToman).toBe(1_000_000);

    const portfolioOpened = await runAiDemoCycle({
      books: [book(99, 100, 2_000)],
      candidates: [aiCandidate(100_000)],
      settings,
      now: 2_000
    });
    expect(portfolioOpened.opened).toBe(1);
    state = await readAiAgentState(1_000_000);
    expect(state.demo.openPositions).toHaveLength(2);
    expect(state.demo.openPositions.filter(position => position.learningOnly)).toHaveLength(1);
    expect(state.demo.openPositions.filter(position => !position.learningOnly)).toHaveLength(1);
    expect(state.demo.cashToman).toBeLessThan(1_000_000);

    const closed = await runAiDemoCycle({
      books: [book(110, 111, 31_000)],
      candidates: [],
      settings,
      now: 31_000
    });
    expect(closed.closed).toBe(2);
    state = await readAiAgentState(1_000_000);
    expect(state.demo.openPositions).toHaveLength(0);
    expect(state.demo.recentTrades).toHaveLength(2);
    const learningTrade = state.demo.recentTrades.find(trade => trade.learningOnly);
    const portfolioTrade = state.demo.recentTrades.find(trade => !trade.learningOnly);
    expect(learningTrade).toBeDefined();
    expect(portfolioTrade).toBeDefined();
    expect(state.demo.realizedPnlToman).toBeCloseTo(portfolioTrade!.pnlToman);
    expect(state.demo.cashToman).toBeCloseTo(1_000_000 + portfolioTrade!.pnlToman);
    expect(state.model.trainingSamples).toBe(2);
  });

  test("Live policy requires Demo evidence and enforces the server-side capital cap", async () => {
    const settings = {
      ...defaultBotSettings.aiAgent,
      enabled: true,
      mode: "live" as const,
      minTrainingSamples: 20,
      minPredictionAccuracyPercent: 60,
      minLiveConfidencePercent: 60,
      maxLiveCapitalToman: 250_000
    };
    let selection = await selectAiLiveSignal({ candidates: [aiCandidate(100_000)], settings });
    expect(selection.selection).toBeUndefined();
    expect(selection.blockers).toContain("insufficient-training-samples");

    await mutateAiAgentState(settings.demoCapitalToman, state => {
      state.model.trainingSamples = 20;
      state.model.correctPredictions = 16;
      state.model.bias = 2;
      state.demo.realizedPnlToman = 25_000;
    });
    selection = await selectAiLiveSignal({ candidates: [aiCandidate(100_000)], settings });
    expect(selection.selection?.candidate.id).toBe("ai-market:BTCUSDT");
    expect(selection.selection!.probability).toBeGreaterThan(0.6);

    selection = await selectAiLiveSignal({ candidates: [aiCandidate(300_000)], settings });
    expect(selection.selection).toBeUndefined();
    expect(selection.blockers).toEqual(["no-qualified-live-candidate"]);
  });
});

function allFeatures(value: number): AiFeatures {
  return Object.fromEntries(AI_FEATURE_NAMES.map(name => [name, value])) as AiFeatures;
}

function decision(index: number): AiDecision {
  return {
    id: `decision-${index}`,
    at: index,
    mode: "demo",
    action: "skipped",
    kind: "orderbook-imbalance",
    symbol: "BTCUSDT",
    probability: 0.5,
    detail: "test"
  };
}

function trade(index: number): AiDemoTrade {
  return {
    id: `trade-${index}`,
    kind: "orderbook-imbalance",
    signalId: "imbalance:BTCUSDT",
    symbol: "BTCUSDT",
    openedAt: index,
    closedAt: index + 1,
    inputToman: 100_000,
    outputToman: 101_000,
    pnlToman: 1_000,
    pnlBps: 100,
    exitReason: "take-profit",
    predictionProbability: 0.75,
    features: allFeatures(0),
    modelVersion: 1
  };
}

function aiCandidate(capitalToman: number): IndependentAiMarketCandidate {
  return {
    id: "ai-market:BTCUSDT",
    kind: "autonomous-market",
    source: "independent-orderbook-scanner",
    symbol: "BTCUSDT",
    base: "BTC",
    quote: "USDT",
    direction: "LONG",
    scannedAt: 1_000,
    bookLastUpdate: 1_000,
    confidencePercent: 80,
    expectedEdgeBps: 150,
    estimatedNetProfitToman: 1_500,
    projectedMoveBps: 200,
    capitalToman,
    executable: true,
    gatePassed: true,
    blockers: [],
    reasons: [],
    rankScore: 90,
    features: allFeatures(0.2),
    metrics: {
      capitalToman,
      entryAssetAmount: 1,
      immediateExitToman: capitalToman * 0.99,
      bestBid: 99,
      bestAsk: 100,
      midpoint: 99.5,
      microprice: 99.7,
      micropriceBiasBps: 2,
      multiLevelImbalance: 0.3,
      snapshotOrderFlow: 0.1,
      bidLiquidityRetentionPercent: 80,
      spreadBps: 100,
      entryPriceImpactBps: 0,
      exitPriceImpactBps: 0,
      maxPriceImpactBps: 0,
      roundTripCostBps: 100,
      visibleBidDepthToman: 1_000_000,
      visibleAskDepthToman: 1_000_000,
      entryDepthConsumedPercent: 1,
      exitDepthConsumedPercent: 1,
      entryAvailableInputToman: 1_000_000,
      exitAvailableInputAsset: 10_000,
      entryLevelsUsed: 1,
      exitLevelsUsed: 1,
      imbalanceRatio: 1.5,
      dominantTopLevelSharePercent: 50,
      bookAgeMs: 0,
      historyTransitions: 3,
      persistencePercent: 100,
      persistenceMs: 5_000
    }
  };
}

function book(bid: number, ask: number, lastUpdate: number): OrderBook {
  return {
    symbol: "BTCUSDT",
    base: "BTC",
    quote: "USDT",
    bids: [{ price: new Decimal(bid), amount: new Decimal(10_000) }],
    asks: [{ price: new Decimal(ask), amount: new Decimal(10_000) }],
    lastUpdate
  };
}
