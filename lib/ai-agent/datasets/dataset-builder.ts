import Decimal from "decimal.js";
import { quoteEdge } from "@/lib/bot/engine";
import type { ConversionEdge } from "@/lib/bot/types";
import {
  AI_OFFLINE_DATASET_VERSION,
  AI_OFFLINE_FEATURE_CONTRACT,
  validateOfflineDataset,
  type OfflineDatasetManifest,
  type OfflineTrainingSample
} from "@/lib/ai-agent/offline";
import { measureIndependentAiBook } from "@/lib/ai-agent/market-scanner";
import type { AiOrderbookObservation } from "@/lib/ai-agent/orderbook-history";
import type { OrderBook } from "@/lib/exchanges/types";
import { fetchTardisBinanceReplay, type FetchTardisReplayOptions } from "./tardis-replay";
import type {
  TardisOfflineDataset,
  TardisReplaySnapshot,
  TardisTrainingEconomics,
  TardisTrainingRequest
} from "./types";

const BPS = new Decimal(10_000);
const DEFAULT_QUOTE_SCALE_TOMAN_PER_USDT = 100_000;
const FEATURE_HISTORY_WINDOW_MS = 30_000;
const MIN_TRAINING_SAMPLES = 60;

export type BuildTardisOfflineDatasetOptions = Pick<FetchTardisReplayOptions, "fetchImpl" | "timeoutMs"> & {
  now?: number;
};

/**
 * Converts the allowlisted replay into the exact independent-scanner feature
 * contract. Labels buy at T and liquidate at T+horizon using full L2 quotes,
 * so spread, both taker fees, configured slippage, depth and price impact are
 * reflected in netPnlBps.
 */
export async function buildTardisOfflineDataset(
  request: TardisTrainingRequest,
  economicsInput: TardisTrainingEconomics,
  options: BuildTardisOfflineDatasetOptions = {}
): Promise<TardisOfflineDataset> {
  const economics = validateEconomics(economicsInput);
  const createdAt = safeTimestamp(options.now ?? Date.now(), "now");
  const replay = await fetchTardisBinanceReplay(request, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    quoteScaleTomanPerUsdt: economics.quoteScaleTomanPerUsdt
  });
  const byTimestamp = new Map(replay.snapshots.map(snapshot => [snapshot.observedAt, snapshot]));
  const samples: OfflineTrainingSample[] = [];
  let historyStart = 0;

  for (let index = 0; index < replay.snapshots.length; index += 1) {
    const current = replay.snapshots[index]!;
    const outcomeAt = current.observedAt + request.horizonMs;
    const future = byTimestamp.get(outcomeAt);
    if (!future) continue;
    while (
      historyStart < index
      && replay.snapshots[historyStart]!.observedAt < current.observedAt - FEATURE_HISTORY_WINDOW_MS
    ) historyStart += 1;
    const observations: AiOrderbookObservation[] = replay.snapshots
      .slice(historyStart, index)
      .map(snapshot => ({ observedAt: snapshot.observedAt, book: cloneBook(snapshot.book) }));
    const measurement = measureIndependentAiBook({
      book: cloneBook(current.book),
      observations,
      capitalToman: economics.capitalToman,
      tomanTakerFeeBps: economics.tomanTakerFeeBps,
      slippageBps: economics.slippageBps,
      now: current.observedAt,
      maxAgeMs: request.sampleIntervalMs * 2,
      historyWindowMs: FEATURE_HISTORY_WINDOW_MS,
      levels: economics.levels,
      minimumLevelsPerSide: 2,
      levelWeightDecayPercent: economics.levelWeightDecayPercent,
      depthUsagePercent: economics.depthUsagePercent,
      maxSpreadBps: 10_000,
      maxPriceImpactBps: 10_000,
      minHistoryTransitions: 1,
      minVisibleDepthToman: 1,
      minImbalanceRatio: 0.000_001,
      minOrderFlowImbalance: 0,
      minLiquidityRetentionPercent: 0,
      minMicropriceBiasBps: 0,
      minPersistencePercent: 0,
      minPersistenceMs: 1,
      maxTopLevelSharePercent: 100,
      minConfidencePercent: 0,
      minExpectedEdgeBps: -100_000
    });
    if (!measurement.candidate) continue;
    const netPnlBps = executableFutureNetPnlBps(current, future, economics);
    if (netPnlBps === undefined) continue;
    samples.push({
      id: `${request.symbol.toLowerCase()}-${current.observedAt}`,
      observedAt: current.observedAt,
      outcomeAt,
      sequence: samples.length,
      features: { ...measurement.candidate.features },
      label: netPnlBps > 0 ? 1 : 0,
      netPnlBps
    });
  }

  if (samples.length < MIN_TRAINING_SAMPLES) {
    throw new Error(`External replay produced only ${samples.length} executable samples; at least ${MIN_TRAINING_SAMPLES} are required`);
  }
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const datasetHash = replay.contentSha256.slice(0, 16);
  const manifest: OfflineDatasetManifest = {
    schemaVersion: AI_OFFLINE_DATASET_VERSION,
    datasetId: `tardis-binance-${request.symbol.toLowerCase()}-${request.date}-${request.minutes}m-${datasetHash}`,
    createdAt,
    source: {
      provider: "Tardis.dev",
      dataset: `Binance Spot depth@100ms + generated depthSnapshot (${request.minutes} UTC minutes)`,
      url: replay.sourceUrls[0]!,
      license: "Tardis.dev sample-data terms; operator must verify permitted use",
      retrievedAt: createdAt,
      contentSha256: replay.contentSha256
    },
    market: {
      venue: "Binance Spot via Tardis.dev",
      symbol: request.symbol,
      baseAsset: request.symbol.slice(0, -4),
      quoteAsset: "USDT",
      marketType: "spot"
    },
    coverage: {
      startAt: first.observedAt,
      endAt: last.observedAt,
      recordCount: samples.length
    },
    labels: {
      horizonMs: request.horizonMs,
      policy: [
        `Positive only when buying at T and selling at T+${request.horizonMs}ms returns net profit`,
        `after both ${economics.tomanTakerFeeBps} BPS fees, ${economics.slippageBps} BPS slippage per leg,`,
        `${economics.depthUsagePercent}% usable L2 depth and price impact.`,
        `USDT prices are scaled by ${economics.quoteScaleTomanPerUsdt} solely to match USDT feature units; this is external Candidate/Shadow data.`
      ].join(" "),
      executableCostsIncluded: true
    },
    featureContract: { ...AI_OFFLINE_FEATURE_CONTRACT }
  };
  const validated = validateOfflineDataset(manifest, samples);
  return {
    manifest: validated.manifest,
    samples: validated.samples,
    replay: replay.stats
  };
}

function executableFutureNetPnlBps(
  current: TardisReplaySnapshot,
  future: TardisReplaySnapshot,
  economics: Required<TardisTrainingEconomics>
) {
  const entry = quote(current.book, "BUY", economics.capitalToman, economics);
  if (!entry) return undefined;
  const exit = quote(future.book, "SELL", entry.output, economics);
  if (!exit) return undefined;
  const result = exit.output.div(economics.capitalToman).minus(1).mul(BPS).toNumber();
  return Number.isFinite(result) ? result : undefined;
}

function quote(
  book: OrderBook,
  side: "BUY" | "SELL",
  input: Decimal.Value,
  economics: Required<TardisTrainingEconomics>
) {
  const edge: ConversionEdge = {
    id: `offline:${book.symbol}:${side}`,
    from: side === "BUY" ? book.quote : book.base,
    to: side === "BUY" ? book.base : book.quote,
    side,
    book
  };
  return quoteEdge(
    edge,
    input,
    economics.tomanTakerFeeBps,
    economics.slippageBps,
    economics.depthUsagePercent
  );
}

function validateEconomics(input: TardisTrainingEconomics): Required<TardisTrainingEconomics> {
  return {
    capitalToman: boundedNumber(input.capitalToman, 1, 1_000_000_000_000, "capitalToman"),
    tomanTakerFeeBps: boundedNumber(input.tomanTakerFeeBps, 0, 10_000, "tomanTakerFeeBps"),
    slippageBps: boundedNumber(input.slippageBps, 0, 9_000, "slippageBps"),
    depthUsagePercent: boundedNumber(input.depthUsagePercent, 1, 100, "depthUsagePercent"),
    levels: boundedInteger(input.levels, 3, 50, "levels"),
    levelWeightDecayPercent: boundedNumber(input.levelWeightDecayPercent, 10, 100, "levelWeightDecayPercent"),
    quoteScaleTomanPerUsdt: boundedNumber(
      input.quoteScaleTomanPerUsdt ?? DEFAULT_QUOTE_SCALE_TOMAN_PER_USDT,
      1,
      10_000_000,
      "quoteScaleTomanPerUsdt"
    )
  };
}

function boundedNumber(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe timestamp`);
  return value;
}

function cloneBook(book: OrderBook): OrderBook {
  const cloneSide = (side: OrderBook["bids"]) => side.map(level => ({ price: new Decimal(level.price), amount: new Decimal(level.amount) }));
  return { ...book, bids: cloneSide(book.bids), asks: cloneSide(book.asks) };
}
