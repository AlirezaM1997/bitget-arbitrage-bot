import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import type { OrderBook } from "@/lib/exchanges/types";
import type { OrderbookObservation } from "@/lib/strategies/orderbook-history";
import { clearOrderbookObservations, recordOrderbookObservations } from "@/lib/strategies/orderbook-history";
import { defaultStrategyLabSettings } from "@/lib/strategy-settings";
import {
  scanOrderbookImbalance
} from "@/lib/strategies/engine";
import { measureAdjacentOrderbookGaps, scanOrderbookGaps } from "@/lib/strategies/orderbook-gap";
import { measureSnapshotOrderFlow, summarizeSnapshotOrderFlow } from "@/lib/strategies/orderbook-imbalance";

const now = 1_800_000_000_000;
const book = (symbol: string, base: string, quote: string, bid: number, ask: number, bidAmount = 1_000_000, askAmount = bidAmount): OrderBook => ({
  symbol, base, quote, lastUpdate: now,
  bids: [{ price: new Decimal(bid), amount: new Decimal(bidAmount) }],
  asks: [{ price: new Decimal(ask), amount: new Decimal(askAmount) }]
});
const depthBook = (bid: number, ask: number, bidAmounts: number[], askAmounts: number[]): OrderBook => ({
  symbol: "XUSDT", base: "X", quote: "USDT", lastUpdate: now,
  bids: bidAmounts.map((amount, index) => ({ price: new Decimal(bid - index), amount: new Decimal(amount) })),
  asks: askAmounts.map((amount, index) => ({ price: new Decimal(ask + index), amount: new Decimal(amount) }))
});
const imbalanceContext = (observations: Array<{ observedAt: number; book: OrderBook }>) => ({
  orderbookHistory: new Map<string, readonly OrderbookObservation[]>([["XUSDT", observations]])
});
const config = {
  settings: defaultStrategyLabSettings,
  tomanTakerFeeBps: 0,
  usdtTakerFeeBps: 0,
  slippageBps: 0,
  maxAgeMs: 5_000
};

describe("strategy lab", () => {
  test("does not count an unchanged REST orderbook as a new confirmation", () => {
    clearOrderbookObservations();
    const snapshot = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    recordOrderbookObservations([snapshot], now - 1_000, { minSampleGapMs: 100 });
    const history = recordOrderbookObservations([snapshot], now, { minSampleGapMs: 100 });
    expect(history.get("XUSDT")).toHaveLength(1);
  });
  test("measures adjacent price gaps with a robust median/MAD baseline", () => {
    const gapBook: OrderBook = {
      symbol: "XUSDT", base: "X", quote: "USDT", lastUpdate: now,
      bids: [99, 98.99, 98.98, 98.97, 98.96].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) })),
      asks: [101, 101.01, 101.02, 105, 105.01].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) }))
    };
    const measured = measureAdjacentOrderbookGaps(gapBook, "ASK", 5);
    expect(measured.candidate.index).toBe(2);
    expect(measured.candidate.gapBps.gt(300)).toBe(true);
    expect(measured.candidate.robustZScore.gt(3)).toBe(true);
  });

  test("measures bullish multi-level snapshot order flow instead of only static depth", () => {
    const previous = depthBook(99, 101, [1_000, 1_000, 1_000], [1_000, 1_000, 1_000]);
    const current = depthBook(99, 101, [2_000, 1_500, 1_000], [500, 750, 1_000]);
    const flow = measureSnapshotOrderFlow(previous, current, 3, 70);
    expect(flow.normalizedFlow.gt(0)).toBe(true);
    expect(flow.bidLiquidityRetentionPercent.toNumber()).toBe(100);
  });

  test("detects fleeting liquidity when a wall moves to different prices", () => {
    const previous = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const moved = depthBook(89, 111, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const summary = summarizeSnapshotOrderFlow([
      { observedAt: now - 1_000, book: previous },
      { observedAt: now, book: moved }
    ], 3, 70);
    expect(summary.sampleCount).toBe(1);
    expect(summary.bidLiquidityRetentionPercent.toNumber()).toBe(0);
  });

  test("keeps a persistent ask gap on watch until forward outcomes are calibrated", () => {
    const gapBook: OrderBook = {
      symbol: "XUSDT", base: "X", quote: "USDT", lastUpdate: now,
      bids: [99, 98.99, 98.98, 98.97, 98.96].map(price => ({ price: new Decimal(price), amount: new Decimal(10_000) })),
      asks: [101, 101.01, 101.02, 105, 105.01].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) }))
    };
    const settings = {
      ...defaultStrategyLabSettings,
      gapTrading: {
        ...defaultStrategyLabSettings.gapTrading,
        enabled: true,
        levels: 5,
        minGapBps: 100,
        minGapZScore: 3,
        minConfirmations: 2,
        minPersistenceMs: 1_000,
        minFlowSamples: 0,
        minOrderFlowImbalance: 0,
        minBidLiquidityRetentionPercent: 0,
        minBidSupportRatio: 1,
        minMicropriceBiasBps: 0,
        maxTopLevelSharePercent: 100,
        minVisibleDepthToman: 1_000,
        maxSpreadBps: 500,
        maxPriceImpactBps: 1_000,
        depthUsagePercent: 100,
        capitalToman: 50_000,
        maxPreGapConsumptionPercent: 100,
        targetCapturePercent: 75,
        minProjectedNetBps: 0,
        safetyBufferBps: 0
      }
    };
    const context = { orderbookHistory: new Map<string, readonly OrderbookObservation[]>([["XUSDT", [
      { observedAt: now - 1_000, book: gapBook },
      { observedAt: now, book: gapBook }
    ]]]) };
    const signal = scanOrderbookGaps([gapBook], { ...config, settings }, now, context).find(item => item.metrics.gapSide === "ASK");
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.analyticalSetupPassed).toBe(true);
    expect(signal?.metrics.spotExecutable).toBe(false);
    expect(signal?.metrics.liveBlocker).toBe("outcomeCalibrated");
  });

  test("blocks a bid-side liquidity gap because Spot cannot short it", () => {
    const gapBook: OrderBook = {
      symbol: "XUSDT", base: "X", quote: "USDT", lastUpdate: now,
      bids: [99, 98.99, 95, 94.99, 94.98].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) })),
      asks: [101, 101.01, 101.02, 101.03, 101.04].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) }))
    };
    const settings = { ...defaultStrategyLabSettings, gapTrading: { ...defaultStrategyLabSettings.gapTrading, enabled: true, levels: 5, minGapBps: 100, minGapZScore: 3 } };
    const signal = scanOrderbookGaps([gapBook], { ...config, settings }, now)[0];
    expect(signal?.status).toBe("blocked");
    expect(signal?.metrics.direction).toBe("SHORT");
    expect(signal?.metrics.spotExecutable).toBe(false);
  });

  test("detects deep orderbook imbalance without claiming guaranteed profit", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 1, capitalToman: 5_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 1, minOutcomeSamples: 0, minPersistenceMs: 0, minPressureDelta: 0, minFlowSamples: 0, minOrderFlowImbalance: 0, minDominantLiquidityRetentionPercent: 0, maxTopLevelSharePercent: 100, minMicropriceBiasBps: 0, stopLossBps: 500 } };
    const signals = scanOrderbookImbalance([book("XUSDT", "X", "USDT", 99, 101, 1_000, 100)], { ...config, settings }, now);
    expect(signals[0]?.status).toBe("actionable");
    expect(signals[0]?.estimatedNetProfitToman.toString()).toBe("0");
    expect(signals[0]?.reasons.some(reason => reason.includes("not guaranteed"))).toBe(true);
  });

  test("keeps an otherwise valid imbalance on watch when round-trip friction consumes Stop Loss", () => {
    const settings = {
      ...defaultStrategyLabSettings,
      imbalance: {
        ...defaultStrategyLabSettings.imbalance,
        levels: 1,
        capitalToman: 250_000,
        minVisibleDepthToman: 1_000,
        maxSpreadBps: 100,
        minRatio: 2,
        minConfirmations: 1,
        minPersistenceMs: 0,
        minPressureDelta: 0,
        minFlowSamples: 0,
        minOrderFlowImbalance: 0,
        minDominantLiquidityRetentionPercent: 0,
        maxTopLevelSharePercent: 100,
        minMicropriceBiasBps: 0,
        stopLossBps: 80,
        maxLossToman: 7_500
      }
    };
    const signal = scanOrderbookImbalance(
      [book("XUSDT", "X", "USDT", 255_735, 257_000, 3_000, 1_000)],
      { ...config, settings, tomanTakerFeeBps: 25, slippageBps: 10 },
      now
    )[0];

    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.roundTripRiskPassed).toBe(false);
    expect(signal?.reasons[0]).toContain("round-trip cost");
  });

  test("keeps a one-snapshot imbalance on watch instead of trading a transient wall", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 3, minPersistenceMs: 2_000, minPressureDelta: 0.05, minMicropriceBiasBps: 0 } };
    const balanced = depthBook(99, 101, [1_000, 1_000, 1_000], [1_000, 1_000, 1_000]);
    const wall = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([wall], { ...config, settings }, now, imbalanceContext([
      { observedAt: now - 2_000, book: balanced },
      { observedAt: now, book: wall }
    ]))[0];
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.confirmations).toBe(1);
    expect(signal?.reasons[0]).toContain("Persistence");
  });

  test("accepts persistent multi-level pressure only after a measurable change point", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, capitalToman: 50_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 3, minOutcomeSamples: 0, minPersistenceMs: 2_000, minPressureDelta: 0.05, minMicropriceBiasBps: 0, stopLossBps: 500 } };
    const balanced = depthBook(99, 101, [1_000, 1_000, 1_000], [1_000, 1_000, 1_000]);
    const pressure = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([pressure], { ...config, settings }, now, imbalanceContext([
      { observedAt: now - 4_000, book: balanced },
      { observedAt: now - 2_000, book: pressure },
      { observedAt: now - 1_000, book: pressure },
      { observedAt: now, book: pressure }
    ]))[0];
    expect(signal?.status).toBe("actionable");
    expect(Number(signal?.metrics.confirmations)).toBe(3);
    expect(Number(signal?.metrics.changePointScore)).toBeGreaterThanOrEqual(0.05);
    expect(signal?.metrics.temporalConfirmed).toBe(true);
    expect(signal?.metrics.executionDepthSafe).toBe(true);
  });

  test("blocks a bid-heavy signal when midpoint falls and indicates absorption", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, capitalToman: 50_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 3, minPersistenceMs: 2_000, minPressureDelta: 0.05, minMicropriceBiasBps: 0, maxAdverseMoveBps: 15 } };
    const balanced = depthBook(99, 101, [1_000, 1_000, 1_000], [1_000, 1_000, 1_000]);
    const pressure = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const fallingPressure = depthBook(98, 100, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([fallingPressure], { ...config, settings }, now, imbalanceContext([
      { observedAt: now - 4_000, book: balanced },
      { observedAt: now - 2_000, book: pressure },
      { observedAt: now - 1_000, book: pressure },
      { observedAt: now, book: fallingPressure }
    ]))[0];
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.priceConfirmationPassed).toBe(false);
    expect(signal?.reasons[0]).toContain("Absorption");
  });

  test("rejects an imbalance concentrated in one spoofable top-level wall", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, capitalToman: 50_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 1, minPersistenceMs: 0, minPressureDelta: 0, minFlowSamples: 0, minOrderFlowImbalance: 0, minDominantLiquidityRetentionPercent: 0, maxTopLevelSharePercent: 70, minMicropriceBiasBps: 0 } };
    const wall = depthBook(99, 101, [5_000, 10, 10], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([wall], { ...config, settings }, now)[0];
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.spoofingGuardPassed).toBe(false);
    expect(signal?.reasons[0]).toContain("Spoofing");
  });
});
