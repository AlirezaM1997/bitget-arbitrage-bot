import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import type { OrderBook } from "@/lib/exchanges/types";
import type { OrderbookObservation } from "@/lib/strategies/orderbook-history";
import {
  measureIndependentAiBook,
  scanIndependentAiMarket
} from "@/lib/ai-agent/market-scanner";

const NOW = 1_800_000_000_000;

describe("independent AI market scanner", () => {
  test("derives an actionable LONG candidate directly from raw USDT books and causal history", () => {
    const current = bullishBook("XUSDT", NOW - 50, 4_500, 500);
    const history = new Map<string, readonly OrderbookObservation[]>([["XUSDT", [
      { observedAt: NOW - 3_000, book: bullishBook("XUSDT", NOW - 3_050, 3_000, 800) },
      { observedAt: NOW - 2_000, book: bullishBook("XUSDT", NOW - 2_050, 3_500, 700) },
      { observedAt: NOW - 1_000, book: bullishBook("XUSDT", NOW - 1_050, 4_000, 600) }
    ]]]);

    const result = scanIndependentAiMarket({
      books: [
        current,
        { ...current, symbol: "XBTC", quote: "BTC" }
      ],
      orderbookHistory: history,
      capitalToman: 10_000,
      tomanTakerFeeBps: 0,
      slippageBps: 0,
      now: NOW,
      levels: 2,
      minimumLevelsPerSide: 2,
      depthUsagePercent: 100,
      maxSpreadBps: 100,
      maxPriceImpactBps: 100
    });

    expect(result.scannedIrtBooks).toBe(1);
    expect(result.actionableCount).toBe(1);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.kind).toBe("autonomous-market");
    expect(candidate.source).toBe("independent-orderbook-scanner");
    expect(candidate.direction).toBe("LONG");
    expect(candidate.symbol).toBe("XUSDT");
    expect(candidate.executable).toBe(true);
    expect(candidate.gatePassed).toBe(true);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.expectedEdgeBps).toBeGreaterThan(0);
    expect(candidate.estimatedNetProfitToman).toBeGreaterThan(0);
    expect(candidate.metrics.historyTransitions).toBe(3);
    expect(candidate.metrics.persistencePercent).toBe(100);
    expect(candidate.metrics.snapshotOrderFlow).toBeGreaterThan(0);
    expect(candidate.metrics.multiLevelImbalance).toBeGreaterThan(0);
    expect(candidate.metrics.entryLevelsUsed).toBeGreaterThan(0);
    expect(candidate.metrics.exitLevelsUsed).toBeGreaterThan(0);
    expect(Object.values(candidate.features).every(value => Number.isFinite(value) && value >= -5 && value <= 5)).toBe(true);
  });

  test("ignores future observations and returns a blocked measurement for offline replay", () => {
    const current = bullishBook("XUSDT", NOW - 50, 4_500, 500);
    const measurement = measureIndependentAiBook({
      book: current,
      observations: [
        { observedAt: NOW + 1_000, book: bullishBook("XUSDT", NOW + 1_000, 9_000, 10) },
        { observedAt: NOW + 2_000, book: bullishBook("XUSDT", NOW + 2_000, 12_000, 5) }
      ],
      capitalToman: 10_000,
      tomanTakerFeeBps: 0,
      slippageBps: 0,
      now: NOW,
      levels: 2,
      depthUsagePercent: 100,
      minOrderFlowImbalance: 0.02
    });

    expect(measurement.candidate).toBeDefined();
    expect(measurement.candidate!.gatePassed).toBe(false);
    expect(measurement.candidate!.metrics.historyTransitions).toBe(0);
    expect(measurement.candidate!.blockers).toContain("insufficient-history");
    expect(measurement.candidate!.blockers).toContain("non-bullish-order-flow");
    expect(measurement.candidate!.features.orderFlow).toBe(0);
  });

  test("hard-rejects stale, crossed and depth-insufficient books", () => {
    const stale = bullishBook("STALEUSDT", NOW - 20_000, 4_500, 500);
    const crossed = book("CROSSUSDT", NOW - 10, [[101, 1_000], [100, 1_000]], [[100, 1_000], [102, 1_000]]);
    const shallow = book("THINUSDT", NOW - 10, [[100, 0.1], [99, 0.1]], [[101, 0.1], [102, 0.1]]);
    const result = scanIndependentAiMarket({
      books: [stale, crossed, shallow],
      capitalToman: 10_000,
      tomanTakerFeeBps: 0,
      slippageBps: 0,
      now: NOW,
      maxAgeMs: 15_000,
      levels: 2,
      minimumLevelsPerSide: 2,
      depthUsagePercent: 100
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejections.map(item => item.reason)).toEqual([
      "stale-book",
      "crossed-book",
      "insufficient-depth"
    ]);
  });
});

function bullishBook(symbol: string, lastUpdate: number, bidAmount: number, askAmount: number) {
  return book(
    symbol,
    lastUpdate,
    [[100, bidAmount], [99.9, bidAmount / 2]],
    [[100.1, askAmount], [100.2, askAmount / 2]]
  );
}

function book(
  symbol: string,
  lastUpdate: number,
  bids: Array<[number, number]>,
  asks: Array<[number, number]>
): OrderBook {
  return {
    symbol,
    base: symbol.replace(/USDT$/, ""),
    quote: "USDT",
    bids: bids.map(([price, amount]) => ({ price: new Decimal(price), amount: new Decimal(amount) })),
    asks: asks.map(([price, amount]) => ({ price: new Decimal(price), amount: new Decimal(amount) })),
    lastUpdate
  };
}
