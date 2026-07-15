import Decimal from "decimal.js";
import type { OrderBook } from "@/lib/exchanges/types";

const BPS = new Decimal(10_000);

export type OrderbookImbalanceMeasurement = {
  bidDepthToman: Decimal;
  askDepthToman: Decimal;
  weightedBidDepthToman: Decimal;
  weightedAskDepthToman: Decimal;
  bidHeavy: boolean;
  ratio: Decimal;
  normalized: Decimal;
  midpoint: Decimal;
  microprice: Decimal;
  micropriceBiasBps: Decimal;
  dominantTopLevelSharePercent: Decimal;
};

export type SnapshotOrderFlowMeasurement = {
  /** Bullish values mean bid additions / ask removals dominate. */
  weightedFlowToman: Decimal;
  normalizedFlow: Decimal;
  normalizationDepthToman: Decimal;
  bidLiquidityRetentionPercent: Decimal;
  askLiquidityRetentionPercent: Decimal;
};

export type SnapshotOrderFlowSummary = {
  sampleCount: number;
  weightedFlowToman: Decimal;
  normalizedFlow: Decimal;
  bidLiquidityRetentionPercent: Decimal;
  askLiquidityRetentionPercent: Decimal;
};

/**
 * Multi-level normalized imbalance with exponentially decaying weights. Near
 * levels influence the signal most, while deeper executable liquidity still
 * contributes. Raw depth remains available for the minimum-liquidity gate.
 */
export function measureOrderbookImbalance(
  book: OrderBook,
  levels: number,
  levelWeightDecayPercent: Decimal.Value,
  quoteToToman: Decimal.Value = 1
): OrderbookImbalanceMeasurement {
  const safeLevels = Math.max(1, Math.floor(levels));
  const decay = new Decimal(levelWeightDecayPercent).div(100);
  const conversion = new Decimal(quoteToToman);
  if (decay.lte(0) || decay.gt(1) || conversion.lte(0)) throw new Error("Invalid imbalance measurement parameters");
  const bids = book.bids.filter(level => level.price.gt(0) && level.amount.gt(0)).slice(0, safeLevels);
  const asks = book.asks.filter(level => level.price.gt(0) && level.amount.gt(0)).slice(0, safeLevels);
  if (!bids.length || !asks.length) throw new Error("Orderbook depth is empty");

  const side = (rows: typeof bids) => rows.reduce((result, level, index) => {
    const value = level.price.mul(level.amount).mul(conversion);
    return {
      raw: result.raw.plus(value),
      weighted: result.weighted.plus(value.mul(decay.pow(index)))
    };
  }, { raw: new Decimal(0), weighted: new Decimal(0) });
  const bid = side(bids);
  const ask = side(asks);
  if (bid.raw.lte(0) || ask.raw.lte(0) || bid.weighted.lte(0) || ask.weighted.lte(0)) throw new Error("Orderbook depth is empty");

  const bidHeavy = bid.weighted.gt(ask.weighted);
  const dominantRows = bidHeavy ? bids : asks;
  const dominantRaw = bidHeavy ? bid.raw : ask.raw;
  const topValue = dominantRows[0].price.mul(dominantRows[0].amount).mul(conversion);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const midpoint = bestBid.price.plus(bestAsk.price).div(2);
  const topAmount = bestBid.amount.plus(bestAsk.amount);
  const microprice = topAmount.gt(0)
    ? bestAsk.price.mul(bestBid.amount).plus(bestBid.price.mul(bestAsk.amount)).div(topAmount)
    : midpoint;
  return {
    bidDepthToman: bid.raw,
    askDepthToman: ask.raw,
    weightedBidDepthToman: bid.weighted,
    weightedAskDepthToman: ask.weighted,
    bidHeavy,
    ratio: Decimal.max(bid.weighted, ask.weighted).div(Decimal.min(bid.weighted, ask.weighted)),
    normalized: bid.weighted.minus(ask.weighted).div(bid.weighted.plus(ask.weighted)),
    midpoint,
    microprice,
    micropriceBiasBps: microprice.div(midpoint).minus(1).mul(BPS),
    dominantTopLevelSharePercent: topValue.div(dominantRaw).mul(100)
  };
}

/**
 * Snapshot approximation of multi-level order-flow imbalance (MLOFI).
 *
 * Bitget's public REST book is a sequence of snapshots rather than an
 * event-level add/cancel feed, so this deliberately avoids claiming exact OFI.
 * The Cont-style price/quantity transition rules still distinguish a static
 * wall from actual bid additions and ask removals. Values are normalized by
 * visible weighted depth so symbols with different prices remain comparable.
 */
export function measureSnapshotOrderFlow(
  previous: OrderBook,
  current: OrderBook,
  levels: number,
  levelWeightDecayPercent: Decimal.Value,
  quoteToToman: Decimal.Value = 1
): SnapshotOrderFlowMeasurement {
  const safeLevels = Math.max(1, Math.floor(levels));
  const decay = new Decimal(levelWeightDecayPercent).div(100);
  const conversion = new Decimal(quoteToToman);
  if (decay.lte(0) || decay.gt(1) || conversion.lte(0)) throw new Error("Invalid order-flow measurement parameters");

  const previousBids = validLevels(previous.bids, safeLevels);
  const previousAsks = validLevels(previous.asks, safeLevels);
  const currentBids = validLevels(current.bids, safeLevels);
  const currentAsks = validLevels(current.asks, safeLevels);
  if (!previousBids.length || !previousAsks.length || !currentBids.length || !currentAsks.length) {
    throw new Error("Orderbook depth is empty");
  }

  let weightedFlowToman = new Decimal(0);
  let normalizationDepthToman = new Decimal(0);
  for (let index = 0; index < safeLevels; index += 1) {
    const weight = decay.pow(index);
    const previousBid = previousBids[index];
    const currentBid = currentBids[index];
    const previousAsk = previousAsks[index];
    const currentAsk = currentAsks[index];
    if (previousBid && currentBid) {
      const previousValue = previousBid.price.mul(previousBid.amount).mul(conversion);
      const currentValue = currentBid.price.mul(currentBid.amount).mul(conversion);
      const bidFlow = currentBid.price.gt(previousBid.price)
        ? currentValue
        : currentBid.price.eq(previousBid.price)
          ? currentValue.minus(previousValue)
          : previousValue.neg();
      weightedFlowToman = weightedFlowToman.plus(bidFlow.mul(weight));
      normalizationDepthToman = normalizationDepthToman.plus(previousValue.plus(currentValue).div(2).mul(weight));
    }
    if (previousAsk && currentAsk) {
      const previousValue = previousAsk.price.mul(previousAsk.amount).mul(conversion);
      const currentValue = currentAsk.price.mul(currentAsk.amount).mul(conversion);
      // Ask removals / a higher best ask are bullish; ask additions / a lower
      // best ask are bearish, hence the inverse signs relative to bids.
      const askFlow = currentAsk.price.gt(previousAsk.price)
        ? previousValue
        : currentAsk.price.eq(previousAsk.price)
          ? previousValue.minus(currentValue)
          : currentValue.neg();
      weightedFlowToman = weightedFlowToman.plus(askFlow.mul(weight));
      normalizationDepthToman = normalizationDepthToman.plus(previousValue.plus(currentValue).div(2).mul(weight));
    }
  }

  return {
    weightedFlowToman,
    normalizedFlow: normalizationDepthToman.gt(0)
      ? weightedFlowToman.div(normalizationDepthToman)
      : new Decimal(0),
    normalizationDepthToman,
    bidLiquidityRetentionPercent: liquidityRetention(previousBids, currentBids, conversion),
    askLiquidityRetentionPercent: liquidityRetention(previousAsks, currentAsks, conversion)
  };
}

/** Aggregates recent snapshot transitions and uses a conservative retention percentile. */
export function summarizeSnapshotOrderFlow(
  observations: readonly { observedAt: number; book: OrderBook }[],
  levels: number,
  levelWeightDecayPercent: Decimal.Value,
  quoteToToman: Decimal.Value = 1,
  maxTransitions = 10
): SnapshotOrderFlowSummary {
  const ordered = observations
    .filter(item => Boolean(item.book))
    .slice()
    .sort((left, right) => left.observedAt - right.observedAt)
    .slice(-(Math.max(1, Math.floor(maxTransitions)) + 1));
  const transitions: SnapshotOrderFlowMeasurement[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    try {
      transitions.push(measureSnapshotOrderFlow(
        ordered[index - 1].book,
        ordered[index].book,
        levels,
        levelWeightDecayPercent,
        quoteToToman
      ));
    } catch {
      // An incomplete snapshot is not useful evidence and is skipped.
    }
  }
  if (!transitions.length) return {
    sampleCount: 0,
    weightedFlowToman: new Decimal(0),
    normalizedFlow: new Decimal(0),
    bidLiquidityRetentionPercent: new Decimal(0),
    askLiquidityRetentionPercent: new Decimal(0)
  };

  const weightedFlowToman = Decimal.sum(...transitions.map(item => item.weightedFlowToman));
  const normalizationDepthToman = Decimal.sum(...transitions.map(item => item.normalizationDepthToman));
  return {
    sampleCount: transitions.length,
    weightedFlowToman,
    normalizedFlow: normalizationDepthToman.gt(0)
      ? weightedFlowToman.div(normalizationDepthToman)
      : new Decimal(0),
    bidLiquidityRetentionPercent: decimalPercentile(
      transitions.map(item => item.bidLiquidityRetentionPercent),
      0.25
    ),
    askLiquidityRetentionPercent: decimalPercentile(
      transitions.map(item => item.askLiquidityRetentionPercent),
      0.25
    )
  };
}

function validLevels(levels: OrderBook["bids"], limit: number) {
  return levels.filter(level => level.price.gt(0) && level.amount.gt(0)).slice(0, limit);
}

function liquidityRetention(
  previous: OrderBook["bids"],
  current: OrderBook["bids"],
  conversion: Decimal
) {
  const currentByPrice = new Map(current.map(level => [level.price.toString(), level]));
  let previousValue = new Decimal(0);
  let retainedValue = new Decimal(0);
  for (const level of previous) {
    const value = level.price.mul(level.amount).mul(conversion);
    previousValue = previousValue.plus(value);
    const match = currentByPrice.get(level.price.toString());
    if (match) retainedValue = retainedValue.plus(level.price.mul(Decimal.min(level.amount, match.amount)).mul(conversion));
  }
  return previousValue.gt(0) ? retainedValue.div(previousValue).mul(100) : new Decimal(0);
}

function decimalPercentile(values: Decimal[], quantile: number) {
  if (!values.length) return new Decimal(0);
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower].plus(sorted[upper].minus(sorted[lower]).mul(position - lower));
}
