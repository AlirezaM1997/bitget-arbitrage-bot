import Decimal from "decimal.js";
import { quoteEdge } from "@/lib/bot/engine";
import type { OrderBook } from "@/lib/exchanges/types";
import type { AiOrderbookObservation as OrderbookObservation } from "./orderbook-history";
import {
  measureOrderbookImbalance,
  summarizeSnapshotOrderFlow
} from "@/lib/strategies/orderbook-imbalance";
import { sanitizeAiFeatures } from "./model";
import type { AiFeatures } from "./types";

const BPS = new Decimal(10_000);
const MAX_FUTURE_SKEW_MS = 1_000;

export type IndependentAiMarketScannerInput = {
  /** Raw exchange snapshots. Strategy-engine signals are deliberately not accepted. */
  books: readonly OrderBook[];
  orderbookHistory?: ReadonlyMap<string, readonly OrderbookObservation[]>;
  capitalToman: Decimal.Value;
  tomanTakerFeeBps: Decimal.Value;
  slippageBps: Decimal.Value;
  now?: number;
  maxAgeMs?: number;
  historyWindowMs?: number;
  levels?: number;
  minimumLevelsPerSide?: number;
  levelWeightDecayPercent?: Decimal.Value;
  depthUsagePercent?: Decimal.Value;
  maxSpreadBps?: Decimal.Value;
  maxPriceImpactBps?: Decimal.Value;
  minHistoryTransitions?: number;
  minVisibleDepthToman?: Decimal.Value;
  minImbalanceRatio?: Decimal.Value;
  minOrderFlowImbalance?: Decimal.Value;
  minLiquidityRetentionPercent?: Decimal.Value;
  minMicropriceBiasBps?: Decimal.Value;
  minPersistencePercent?: Decimal.Value;
  minPersistenceMs?: number;
  maxTopLevelSharePercent?: Decimal.Value;
  minConfidencePercent?: Decimal.Value;
  minExpectedEdgeBps?: Decimal.Value;
};

export type IndependentAiMarketRejectionReason =
  | "unsupported-quote"
  | "duplicate-symbol"
  | "stale-book"
  | "future-book"
  | "empty-book"
  | "insufficient-levels"
  | "crossed-book"
  | "spread-too-wide"
  | "insufficient-depth"
  | "impact-too-high"
  | "insufficient-visible-depth"
  | "insufficient-history"
  | "imbalance-too-weak"
  | "top-level-concentration"
  | "non-bullish-structure"
  | "non-bullish-order-flow"
  | "low-liquidity-retention"
  | "low-persistence"
  | "persistence-too-short"
  | "low-confidence"
  | "edge-below-threshold";

export type IndependentAiMarketRejection = {
  symbol: string;
  reason: IndependentAiMarketRejectionReason;
  detail: string;
};

export type IndependentAiMarketCandidate = {
  id: string;
  kind: "autonomous-market";
  source: "independent-orderbook-scanner";
  symbol: string;
  base: string;
  quote: "USDT";
  direction: "LONG";
  scannedAt: number;
  bookLastUpdate: number;
  confidencePercent: number;
  expectedEdgeBps: number;
  estimatedNetProfitToman: number;
  projectedMoveBps: number;
  capitalToman: number;
  /** Quotes can fill both entry and immediate liquidation at scan time. */
  executable: true;
  /** Demo/Live must require this in addition to its own server-side revalidation. */
  gatePassed: boolean;
  blockers: IndependentAiMarketRejectionReason[];
  reasons: string[];
  rankScore: number;
  features: AiFeatures;
  metrics: {
    capitalToman: number;
    entryAssetAmount: number;
    immediateExitToman: number;
    bestBid: number;
    bestAsk: number;
    midpoint: number;
    microprice: number;
    micropriceBiasBps: number;
    multiLevelImbalance: number;
    snapshotOrderFlow: number;
    bidLiquidityRetentionPercent: number;
    spreadBps: number;
    entryPriceImpactBps: number;
    exitPriceImpactBps: number;
    maxPriceImpactBps: number;
    roundTripCostBps: number;
    visibleBidDepthToman: number;
    visibleAskDepthToman: number;
    entryDepthConsumedPercent: number;
    exitDepthConsumedPercent: number;
    entryAvailableInputToman: number;
    exitAvailableInputAsset: number;
    entryLevelsUsed: number;
    exitLevelsUsed: number;
    imbalanceRatio: number;
    dominantTopLevelSharePercent: number;
    bookAgeMs: number;
    historyTransitions: number;
    persistencePercent: number;
    persistenceMs: number;
  };
};

export type IndependentAiMarketScanResult = {
  scannedAt: number;
  scannedIrtBooks: number;
  candidates: IndependentAiMarketCandidate[];
  actionableCount: number;
  rejections: IndependentAiMarketRejection[];
};

export type IndependentAiBookMeasurementInput = Omit<
  IndependentAiMarketScannerInput,
  "books" | "orderbookHistory"
> & {
  book: OrderBook;
  observations?: readonly OrderbookObservation[];
};

export type IndependentAiBookMeasurement = {
  candidate?: IndependentAiMarketCandidate;
  rejections: IndependentAiMarketRejection[];
};

type ScannerConfig = {
  now: number;
  capitalToman: Decimal;
  feeBps: Decimal;
  slippageBps: Decimal;
  maxAgeMs: number;
  historyWindowMs: number;
  levels: number;
  minimumLevelsPerSide: number;
  levelWeightDecayPercent: Decimal;
  depthUsagePercent: Decimal;
  maxSpreadBps: Decimal;
  maxPriceImpactBps: Decimal;
  minHistoryTransitions: number;
  minVisibleDepthToman: Decimal;
  minImbalanceRatio: Decimal;
  minOrderFlowImbalance: Decimal;
  minLiquidityRetentionPercent: Decimal;
  minMicropriceBiasBps: Decimal;
  minPersistencePercent: Decimal;
  minPersistenceMs: number;
  maxTopLevelSharePercent: Decimal;
  minConfidencePercent: Decimal;
  minExpectedEdgeBps: Decimal;
};

/**
 * Scans USDT spot books directly and only returns independently derived LONG
 * candidates. It is a pure analytical function: it performs no I/O, network
 * request, state mutation or order submission.
 */
export function scanIndependentAiMarket(
  input: IndependentAiMarketScannerInput
): IndependentAiMarketScanResult {
  const config = scannerConfig(input);
  const candidates: IndependentAiMarketCandidate[] = [];
  const rejections: IndependentAiMarketRejection[] = [];
  const seen = new Set<string>();
  let scannedIrtBooks = 0;

  for (const rawBook of input.books) {
    if (rawBook.quote.toUpperCase() !== "USDT") continue;
    scannedIrtBooks += 1;
    const symbol = rawBook.symbol.toUpperCase();
    if (seen.has(symbol)) {
      reject(rejections, symbol, "duplicate-symbol", "Only the first snapshot for a symbol is scanned");
      continue;
    }
    seen.add(symbol);

    const measurement = measureBook(
      normalizeBook(rawBook),
      input.orderbookHistory?.get(rawBook.symbol)
        ?? input.orderbookHistory?.get(symbol)
        ?? [],
      config
    );
    rejections.push(...measurement.rejections);
    if (measurement.candidate) candidates.push(measurement.candidate);
  }

  candidates.sort((left, right) =>
    right.rankScore - left.rankScore
      || right.expectedEdgeBps - left.expectedEdgeBps
      || left.symbol.localeCompare(right.symbol)
  );
  return {
    scannedAt: config.now,
    scannedIrtBooks,
    candidates,
    actionableCount: candidates.filter(candidate => candidate.gatePassed).length,
    rejections
  };
}

/**
 * Measures one raw book without requiring the strict opportunity gates to
 * pass. This is useful for causal offline replay: structurally valid and
 * executable snapshots still expose bounded features plus explicit blockers.
 */
export function measureIndependentAiBook(
  input: IndependentAiBookMeasurementInput
): IndependentAiBookMeasurement {
  if (input.book.quote.toUpperCase() !== "USDT") {
    return {
      rejections: [{
        symbol: input.book.symbol.toUpperCase(),
        reason: "unsupported-quote",
        detail: "Independent scanner only measures USDT-quoted books"
      }]
    };
  }
  return measureBook(
    normalizeBook(input.book),
    input.observations ?? [],
    scannerConfig({ ...input, books: [input.book] })
  );
}

function measureBook(
  book: OrderBook,
  rawHistory: readonly OrderbookObservation[],
  config: ScannerConfig
): IndependentAiBookMeasurement {
  const rejections: IndependentAiMarketRejection[] = [];
  const symbol = book.symbol.toUpperCase();
  const ageMs = config.now - book.lastUpdate;
  if (ageMs < -MAX_FUTURE_SKEW_MS) {
    reject(rejections, symbol, "future-book", `Book is ${Math.abs(ageMs)}ms ahead of scanner time`);
    return { rejections };
  }
  if (ageMs > config.maxAgeMs) {
    reject(rejections, symbol, "stale-book", `Book age ${ageMs}ms exceeds ${config.maxAgeMs}ms`);
    return { rejections };
  }
  if (!book.bids.length || !book.asks.length) {
    reject(rejections, symbol, "empty-book", "Both bid and ask sides are required");
    return { rejections };
  }
  if (book.bids.length < config.minimumLevelsPerSide || book.asks.length < config.minimumLevelsPerSide) {
    reject(
      rejections,
      symbol,
      "insufficient-levels",
      `Requires ${config.minimumLevelsPerSide} valid levels on each side`
    );
    return { rejections };
  }

  const bestBid = book.bids[0]!.price;
  const bestAsk = book.asks[0]!.price;
  if (bestBid.gte(bestAsk)) {
    reject(rejections, symbol, "crossed-book", "Best bid must be strictly below best ask");
    return { rejections };
  }

  let imbalance: ReturnType<typeof measureOrderbookImbalance>;
  try {
    imbalance = measureOrderbookImbalance(
      book,
      config.levels,
      config.levelWeightDecayPercent
    );
  } catch {
    reject(rejections, symbol, "empty-book", "Usable multi-level depth is missing");
    return { rejections };
  }
  const spreadBps = bestAsk.minus(bestBid).div(imbalance.midpoint).mul(BPS);

  const entry = quote("BUY", book, config.capitalToman, config);
  if (!entry) {
    reject(rejections, symbol, "insufficient-depth", "Asks cannot fill the configured USDT capital");
    return { rejections };
  }
  const exit = quote("SELL", book, entry.output, config);
  if (!exit) {
    reject(rejections, symbol, "insufficient-depth", "Bids cannot liquidate the acquired asset");
    return { rejections };
  }
  const maxImpactBps = Decimal.max(entry.priceImpactBps, exit.priceImpactBps);

  const observations = causalObservations(book, rawHistory, config);
  const flow = summarizeSnapshotOrderFlow(
    observations,
    config.levels,
    config.levelWeightDecayPercent,
    1,
    Math.max(config.minHistoryTransitions, 10)
  );
  const persistence = measureBullishPersistence(observations, config);

  const roundTripReturnBps = exit.output.div(config.capitalToman).minus(1).mul(BPS);
  const roundTripCostBps = Decimal.max(roundTripReturnBps.neg(), 0);
  const projectedMoveBps = forecastMoveBps({
    micropriceBiasBps: imbalance.micropriceBiasBps,
    normalizedImbalance: imbalance.normalized,
    normalizedFlow: flow.normalizedFlow,
    bidRetentionPercent: flow.bidLiquidityRetentionPercent,
    persistencePercent: persistence.percent
  });
  const expectedEdgeBps = projectedMoveBps.minus(roundTripCostBps);
  const confidencePercent = estimateConfidencePercent({
    micropriceBiasBps: imbalance.micropriceBiasBps,
    spreadBps,
    normalizedImbalance: imbalance.normalized,
    normalizedFlow: flow.normalizedFlow,
    bidRetentionPercent: flow.bidLiquidityRetentionPercent,
    persistencePercent: persistence.percent
  });
  const blockers: IndependentAiMarketRejectionReason[] = [];
  const block = (reason: IndependentAiMarketRejectionReason, detail: string) => {
    blockers.push(reason);
    reject(rejections, symbol, reason, detail);
  };
  if (spreadBps.gt(config.maxSpreadBps)) block("spread-too-wide", `Spread is ${fixed(spreadBps)} BPS`);
  if (maxImpactBps.gt(config.maxPriceImpactBps)) block("impact-too-high", `Price impact is ${fixed(maxImpactBps)} BPS`);
  if (Decimal.min(imbalance.bidDepthToman, imbalance.askDepthToman).lt(config.minVisibleDepthToman)) {
    block("insufficient-visible-depth", `Visible depth is below ${fixed(config.minVisibleDepthToman)} USDT`);
  }
  if (flow.sampleCount < config.minHistoryTransitions) {
    block("insufficient-history", `Found ${flow.sampleCount} causal transitions; requires ${config.minHistoryTransitions}`);
  }
  if (imbalance.normalized.lte(0) || imbalance.micropriceBiasBps.lt(config.minMicropriceBiasBps)) {
    block("non-bullish-structure", "Imbalance and microprice do not both support LONG");
  }
  if (!imbalance.bidHeavy || imbalance.ratio.lt(config.minImbalanceRatio)) {
    block("imbalance-too-weak", `Bid/ask depth ratio is ${fixed(imbalance.ratio)}`);
  }
  if (imbalance.dominantTopLevelSharePercent.gt(config.maxTopLevelSharePercent)) {
    block("top-level-concentration", `Top-level concentration is ${fixed(imbalance.dominantTopLevelSharePercent)}%`);
  }
  if (flow.normalizedFlow.lt(config.minOrderFlowImbalance)) {
    block("non-bullish-order-flow", `Recent snapshot OFI ${fixed(flow.normalizedFlow)} is below ${fixed(config.minOrderFlowImbalance)}`);
  }
  if (flow.bidLiquidityRetentionPercent.lt(config.minLiquidityRetentionPercent)) {
    block("low-liquidity-retention", `Bid retention is ${fixed(flow.bidLiquidityRetentionPercent)}%`);
  }
  if (persistence.percent.lt(config.minPersistencePercent)) {
    block("low-persistence", `Bullish persistence is ${fixed(persistence.percent)}%`);
  }
  if (persistence.ms < config.minPersistenceMs) {
    block("persistence-too-short", `Bullish persistence is ${persistence.ms}ms`);
  }
  if (confidencePercent.lt(config.minConfidencePercent)) {
    block("low-confidence", `Confidence is ${fixed(confidencePercent)}%`);
  }
  if (expectedEdgeBps.lt(config.minExpectedEdgeBps)) {
    block("edge-below-threshold", `Expected edge is ${fixed(expectedEdgeBps)} BPS`);
  }

  const features = sanitizeAiFeatures({
    expectedEdge: clampNumber(expectedEdgeBps.div(100).toNumber(), -5, 5),
    confidence: clampNumber(confidencePercent.div(100).toNumber(), 0, 1),
    orderFlow: clampNumber(flow.normalizedFlow.toNumber(), -2, 2),
    microprice: clampNumber(imbalance.micropriceBiasBps.div(10).toNumber(), -5, 5),
    retention: clampNumber(flow.bidLiquidityRetentionPercent.div(100).toNumber(), 0, 1),
    spread: clampNumber(spreadBps.div(100).toNumber(), 0, 5),
    impact: clampNumber(maxImpactBps.div(100).toNumber(), 0, 5),
    roundTripCost: clampNumber(roundTripCostBps.div(100).toNumber(), 0, 5),
    persistence: clampNumber(new Decimal(persistence.ms).div(10_000).toNumber(), 0, 5),
    // Independent evidence is neither a Gap (-1) nor Imbalance (+1) engine label.
    kind: 0
  });
  const rankScore = confidencePercent.plus(Decimal.max(expectedEdgeBps, 0).div(10)).toNumber();

  const expectedNetProfitToman = config.capitalToman.mul(expectedEdgeBps).div(BPS);
  const candidate: IndependentAiMarketCandidate = {
    id: `ai-market:${symbol}`,
    kind: "autonomous-market",
    source: "independent-orderbook-scanner",
    symbol,
    base: book.base.toUpperCase(),
    quote: "USDT",
    direction: "LONG",
    scannedAt: config.now,
    bookLastUpdate: book.lastUpdate,
    confidencePercent: finiteNumber(confidencePercent),
    expectedEdgeBps: finiteNumber(expectedEdgeBps),
    estimatedNetProfitToman: finiteNumber(expectedNetProfitToman),
    projectedMoveBps: finiteNumber(projectedMoveBps),
    capitalToman: finiteNumber(config.capitalToman),
    executable: true,
    gatePassed: blockers.length === 0,
    blockers,
    reasons: evidenceReasons({
      imbalance: imbalance.normalized,
      micropriceBiasBps: imbalance.micropriceBiasBps,
      orderFlow: flow.normalizedFlow,
      retentionPercent: flow.bidLiquidityRetentionPercent,
      persistencePercent: persistence.percent,
      roundTripCostBps
    }),
    rankScore: Number.isFinite(rankScore) ? rankScore : 0,
    features,
    metrics: {
      capitalToman: finiteNumber(config.capitalToman),
      entryAssetAmount: finiteNumber(entry.output),
      immediateExitToman: finiteNumber(exit.output),
      bestBid: finiteNumber(bestBid),
      bestAsk: finiteNumber(bestAsk),
      midpoint: finiteNumber(imbalance.midpoint),
      microprice: finiteNumber(imbalance.microprice),
      micropriceBiasBps: finiteNumber(imbalance.micropriceBiasBps),
      multiLevelImbalance: finiteNumber(imbalance.normalized),
      snapshotOrderFlow: finiteNumber(flow.normalizedFlow),
      bidLiquidityRetentionPercent: finiteNumber(flow.bidLiquidityRetentionPercent),
      spreadBps: finiteNumber(spreadBps),
      entryPriceImpactBps: finiteNumber(entry.priceImpactBps),
      exitPriceImpactBps: finiteNumber(exit.priceImpactBps),
      maxPriceImpactBps: finiteNumber(maxImpactBps),
      roundTripCostBps: finiteNumber(roundTripCostBps),
      visibleBidDepthToman: finiteNumber(imbalance.bidDepthToman),
      visibleAskDepthToman: finiteNumber(imbalance.askDepthToman),
      entryDepthConsumedPercent: finiteNumber(entry.depthConsumedPercent),
      exitDepthConsumedPercent: finiteNumber(exit.depthConsumedPercent),
      entryAvailableInputToman: finiteNumber(entry.availableInput),
      exitAvailableInputAsset: finiteNumber(exit.availableInput),
      entryLevelsUsed: entry.levelsUsed,
      exitLevelsUsed: exit.levelsUsed,
      imbalanceRatio: finiteNumber(imbalance.ratio),
      dominantTopLevelSharePercent: finiteNumber(imbalance.dominantTopLevelSharePercent),
      bookAgeMs: Math.max(0, ageMs),
      historyTransitions: flow.sampleCount,
      persistencePercent: finiteNumber(persistence.percent),
      persistenceMs: persistence.ms
    }
  };
  return { candidate, rejections };
}

function scannerConfig(input: IndependentAiMarketScannerInput): ScannerConfig {
  const capitalToman = positiveDecimal(input.capitalToman, "capitalToman");
  const feeBps = nonNegativeDecimal(input.tomanTakerFeeBps, "tomanTakerFeeBps");
  const slippageBps = nonNegativeDecimal(input.slippageBps, "slippageBps");
  const depthUsagePercent = positiveDecimal(input.depthUsagePercent ?? 90, "depthUsagePercent");
  if (depthUsagePercent.gt(100)) throw new Error("depthUsagePercent cannot exceed 100");
  const decay = positiveDecimal(input.levelWeightDecayPercent ?? 85, "levelWeightDecayPercent");
  if (decay.gt(100)) throw new Error("levelWeightDecayPercent cannot exceed 100");
  return {
    now: Math.max(0, Math.floor(input.now ?? Date.now())),
    capitalToman,
    feeBps,
    slippageBps,
    maxAgeMs: positiveInteger(input.maxAgeMs ?? 15_000, "maxAgeMs"),
    historyWindowMs: positiveInteger(input.historyWindowMs ?? 30_000, "historyWindowMs"),
    levels: boundedInteger(input.levels ?? 10, 1, 100, "levels"),
    minimumLevelsPerSide: boundedInteger(input.minimumLevelsPerSide ?? 2, 1, 100, "minimumLevelsPerSide"),
    levelWeightDecayPercent: decay,
    depthUsagePercent,
    maxSpreadBps: nonNegativeDecimal(input.maxSpreadBps ?? 300, "maxSpreadBps"),
    maxPriceImpactBps: nonNegativeDecimal(input.maxPriceImpactBps ?? 100, "maxPriceImpactBps"),
    minHistoryTransitions: boundedInteger(input.minHistoryTransitions ?? 2, 1, 100, "minHistoryTransitions"),
    minVisibleDepthToman: positiveDecimal(input.minVisibleDepthToman ?? 1, "minVisibleDepthToman"),
    minImbalanceRatio: positiveDecimal(input.minImbalanceRatio ?? 1, "minImbalanceRatio"),
    minOrderFlowImbalance: nonNegativeDecimal(input.minOrderFlowImbalance ?? 0, "minOrderFlowImbalance"),
    minLiquidityRetentionPercent: boundedPercent(input.minLiquidityRetentionPercent ?? 50, "minLiquidityRetentionPercent"),
    minMicropriceBiasBps: nonNegativeDecimal(input.minMicropriceBiasBps ?? 0, "minMicropriceBiasBps"),
    minPersistencePercent: boundedPercent(input.minPersistencePercent ?? 50, "minPersistencePercent"),
    minPersistenceMs: positiveInteger(input.minPersistenceMs ?? 500, "minPersistenceMs"),
    maxTopLevelSharePercent: boundedPercent(input.maxTopLevelSharePercent ?? 100, "maxTopLevelSharePercent"),
    minConfidencePercent: boundedPercent(input.minConfidencePercent ?? 55, "minConfidencePercent"),
    minExpectedEdgeBps: finiteDecimal(input.minExpectedEdgeBps ?? 0, "minExpectedEdgeBps")
  };
}

function normalizeBook(book: OrderBook): OrderBook {
  const valid = (levels: OrderBook["bids"]) => levels
    .filter(level => level.price.isFinite() && level.amount.isFinite() && level.price.gt(0) && level.amount.gt(0));
  return {
    ...book,
    symbol: book.symbol.toUpperCase(),
    base: book.base.toUpperCase(),
    quote: book.quote.toUpperCase(),
    bids: valid(book.bids).sort((left, right) => right.price.comparedTo(left.price)),
    asks: valid(book.asks).sort((left, right) => left.price.comparedTo(right.price))
  };
}

function causalObservations(
  current: OrderBook,
  history: readonly OrderbookObservation[],
  config: ScannerConfig
) {
  const earliest = config.now - config.historyWindowMs;
  const ordered = history
    .filter(item => item.observedAt >= earliest && item.observedAt <= config.now)
    .filter(item => item.book.symbol.toUpperCase() === current.symbol.toUpperCase())
    .filter(item => item.book.quote.toUpperCase() === "USDT")
    .filter(item => item.book.lastUpdate <= config.now + MAX_FUTURE_SKEW_MS)
    // Critical for offline replay: a snapshot evaluated at T must never see an
    // exchange update newer than the current book, even if observedAt is bad.
    .filter(item => item.book.lastUpdate <= current.lastUpdate)
    .map(item => ({ observedAt: item.observedAt, book: normalizeBook(item.book) }))
    .filter(item => item.book.bids.length > 0 && item.book.asks.length > 0)
    .filter(item => item.book.bids[0]!.price.lt(item.book.asks[0]!.price))
    .sort((left, right) => left.observedAt - right.observedAt);
  const observations: OrderbookObservation[] = [];
  for (const observation of ordered) {
    const previous = observations[observations.length - 1];
    // Repeated REST responses are not independent temporal confirmation.
    if (!previous || bookFingerprint(previous.book) !== bookFingerprint(observation.book)) {
      observations.push(observation);
    }
  }
  const last = observations[observations.length - 1];
  if (!last || bookFingerprint(last.book) !== bookFingerprint(current)) {
    observations.push({ observedAt: config.now, book: current });
  }
  return observations;
}

function measureBullishPersistence(
  observations: readonly OrderbookObservation[],
  config: ScannerConfig
) {
  const evidence = observations.map(observation => {
    try {
      const measurement = measureOrderbookImbalance(
        observation.book,
        config.levels,
        config.levelWeightDecayPercent
      );
      return {
        observedAt: observation.observedAt,
        bullish: measurement.normalized.gt(0) && measurement.micropriceBiasBps.gt(0)
      };
    } catch {
      return { observedAt: observation.observedAt, bullish: false };
    }
  });
  const bullishCount = evidence.filter(item => item.bullish).length;
  const percent = evidence.length
    ? new Decimal(bullishCount).div(evidence.length).mul(100)
    : new Decimal(0);
  let trailingStart: number | undefined;
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (!evidence[index]!.bullish) break;
    trailingStart = evidence[index]!.observedAt;
  }
  const lastAt = evidence[evidence.length - 1]?.observedAt ?? config.now;
  return {
    percent,
    ms: trailingStart === undefined ? 0 : Math.max(0, lastAt - trailingStart)
  };
}

function forecastMoveBps(input: {
  micropriceBiasBps: Decimal;
  normalizedImbalance: Decimal;
  normalizedFlow: Decimal;
  bidRetentionPercent: Decimal;
  persistencePercent: Decimal;
}) {
  const raw = Decimal.max(input.micropriceBiasBps, 0)
    .plus(Decimal.max(input.normalizedImbalance, 0).mul(45))
    .plus(Decimal.max(input.normalizedFlow, 0).mul(35));
  const retentionQuality = new Decimal(0.5)
    .plus(clampDecimal(input.bidRetentionPercent.div(100), 0, 1).mul(0.5));
  const persistenceQuality = new Decimal(0.4)
    .plus(clampDecimal(input.persistencePercent.div(100), 0, 1).mul(0.6));
  // A snapshot heuristic must never claim an unbounded move forecast.
  return Decimal.min(raw.mul(retentionQuality).mul(persistenceQuality), 150);
}

function estimateConfidencePercent(input: {
  micropriceBiasBps: Decimal;
  spreadBps: Decimal;
  normalizedImbalance: Decimal;
  normalizedFlow: Decimal;
  bidRetentionPercent: Decimal;
  persistencePercent: Decimal;
}) {
  const halfSpread = Decimal.max(input.spreadBps.div(2), 1);
  const micro = clampDecimal(input.micropriceBiasBps.div(halfSpread), 0, 1);
  const imbalance = clampDecimal(input.normalizedImbalance.div(0.5), 0, 1);
  const flow = clampDecimal(input.normalizedFlow.div(0.25), 0, 1);
  const retention = clampDecimal(input.bidRetentionPercent.div(100), 0, 1);
  const persistence = clampDecimal(input.persistencePercent.div(100), 0, 1);
  const evidence = imbalance.mul(0.25)
    .plus(micro.mul(0.2))
    .plus(flow.mul(0.25))
    .plus(retention.mul(0.15))
    .plus(persistence.mul(0.15));
  return Decimal.min(new Decimal(50).plus(evidence.mul(49)), 99);
}

function evidenceReasons(input: {
  imbalance: Decimal;
  micropriceBiasBps: Decimal;
  orderFlow: Decimal;
  retentionPercent: Decimal;
  persistencePercent: Decimal;
  roundTripCostBps: Decimal;
}) {
  const reasons: string[] = [];
  if (input.imbalance.gt(0)) reasons.push(`Bullish multi-level imbalance ${fixed(input.imbalance)}`);
  if (input.micropriceBiasBps.gt(0)) reasons.push(`Microprice bias +${fixed(input.micropriceBiasBps)} BPS`);
  if (input.orderFlow.gt(0)) reasons.push(`Bullish snapshot OFI ${fixed(input.orderFlow)}`);
  reasons.push(`Bid liquidity retention ${fixed(input.retentionPercent)}%`);
  reasons.push(`Bullish persistence ${fixed(input.persistencePercent)}%`);
  reasons.push(`Executable round-trip cost ${fixed(input.roundTripCostBps)} BPS`);
  return reasons;
}

function quote(side: "BUY" | "SELL", book: OrderBook, input: Decimal.Value, config: ScannerConfig) {
  return quoteEdge({
    id: `${book.symbol}:${side}`,
    from: side === "BUY" ? book.quote : book.base,
    to: side === "BUY" ? book.base : book.quote,
    side,
    book
  }, input, config.feeBps, config.slippageBps, config.depthUsagePercent);
}

function reject(
  rejections: IndependentAiMarketRejection[],
  symbol: string,
  reason: IndependentAiMarketRejectionReason,
  detail: string
): undefined {
  rejections.push({ symbol, reason, detail });
  return undefined;
}

function bookFingerprint(book: OrderBook) {
  const side = (levels: OrderBook["bids"]) => levels.slice(0, 10)
    .map(level => `${level.price.toString()}:${level.amount.toString()}`)
    .join("|");
  return `${book.lastUpdate}:${side(book.bids)}::${side(book.asks)}`;
}

function fixed(value: Decimal) {
  return value.toDecimalPlaces(2).toString();
}

function finiteNumber(value: Decimal) {
  const result = value.toNumber();
  return Number.isFinite(result) ? result : 0;
}

function clampDecimal(value: Decimal, minimum: Decimal.Value, maximum: Decimal.Value) {
  return Decimal.min(maximum, Decimal.max(minimum, value));
}

function clampNumber(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveDecimal(value: Decimal.Value, name: string) {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lte(0)) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonNegativeDecimal(value: Decimal.Value, name: string) {
  const parsed = finiteDecimal(value, name);
  if (parsed.lt(0)) throw new Error(`${name} cannot be negative`);
  return parsed;
}

function finiteDecimal(value: Decimal.Value, name: string) {
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error(`${name} must be finite`);
  return parsed;
}

function boundedPercent(value: Decimal.Value, name: string) {
  const parsed = nonNegativeDecimal(value, name);
  if (parsed.gt(100)) throw new Error(`${name} cannot exceed 100`);
  return parsed;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
