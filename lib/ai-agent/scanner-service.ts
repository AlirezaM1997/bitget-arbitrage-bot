import type { BotSettings } from "@/lib/bot-settings";
import type { OrderBook } from "@/lib/exchanges/types";
import {
  scanIndependentAiMarket,
  type IndependentAiMarketScanResult
} from "./market-scanner";
import { recordAiOrderbookObservations } from "./orderbook-history";

type ScannerRuntime = { lastScan: IndependentAiMarketScanResult | null };
type ScannerGlobal = typeof globalThis & { __bitgetAiScannerRuntime?: ScannerRuntime };

export function scanAiMarketBooks(
  books: readonly OrderBook[],
  settings: BotSettings,
  options: { capitalToman?: number; now?: number; recordHistory?: boolean } = {}
) {
  const now = options.now ?? Date.now();
  const ai = settings.aiAgent;
  const maximumSamples = Math.max(20, Math.ceil(ai.scannerSampleWindowMs / Math.max(500, settings.scanIntervalMs)) + 5);
  const history = options.recordHistory === false
    ? undefined
    : recordAiOrderbookObservations(books, now, {
        maxAgeMs: ai.scannerSampleWindowMs + 5_000,
        maxSamples: maximumSamples,
        minSampleGapMs: Math.min(1_000, settings.scanIntervalMs)
      });
  const result = scanIndependentAiMarket({
    books,
    orderbookHistory: history,
    capitalToman: options.capitalToman ?? (ai.mode === "live" ? ai.maxLiveCapitalToman : ai.demoTradeCapitalToman),
    tomanTakerFeeBps: settings.tomanTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    now,
    maxAgeMs: settings.orderbookMaxAgeMs,
    historyWindowMs: ai.scannerSampleWindowMs,
    levels: ai.scannerLevels,
    minimumLevelsPerSide: Math.min(3, ai.scannerLevels),
    levelWeightDecayPercent: ai.scannerLevelWeightDecayPercent,
    depthUsagePercent: ai.scannerDepthUsagePercent,
    maxSpreadBps: ai.scannerMaxSpreadBps,
    maxPriceImpactBps: ai.scannerMaxPriceImpactBps,
    // N snapshots contain at most N-1 causal transitions.
    minHistoryTransitions: Math.max(1, ai.scannerMinHistorySamples - 1),
    minVisibleDepthToman: ai.scannerMinVisibleDepthToman,
    minImbalanceRatio: ai.scannerMinImbalanceRatio,
    minOrderFlowImbalance: ai.scannerMinOrderFlowImbalance,
    minLiquidityRetentionPercent: ai.scannerMinLiquidityRetentionPercent,
    minMicropriceBiasBps: ai.scannerMinMicropriceBiasBps,
    minPersistencePercent: ai.scannerMinPersistencePercent,
    minPersistenceMs: ai.scannerMinPersistenceMs,
    maxTopLevelSharePercent: ai.scannerMaxTopLevelSharePercent,
    minConfidencePercent: ai.scannerMinConfidencePercent,
    minExpectedEdgeBps: ai.scannerMinExpectedEdgeBps
  });
  scannerRuntime().lastScan = result;
  return result;
}

/** Bounded process-local diagnostics for the dashboard; never execution authority. */
export function getAiMarketScannerStatus() {
  const scan = scannerRuntime().lastScan;
  if (!scan) {
    return {
      scannedAt: null,
      scannedIrtBooks: 0,
      actionableCount: 0,
      candidates: [],
      rejectionSummary: {},
      recentRejections: []
    };
  }
  const rejectionSummary = scan.rejections.reduce<Record<string, number>>((summary, item) => {
    summary[item.reason] = (summary[item.reason] ?? 0) + 1;
    return summary;
  }, {});
  return {
    scannedAt: scan.scannedAt,
    scannedIrtBooks: scan.scannedIrtBooks,
    actionableCount: scan.actionableCount,
    candidates: scan.candidates.slice(0, 20),
    rejectionSummary,
    recentRejections: scan.rejections.slice(-50).reverse()
  };
}

function scannerRuntime() {
  const root = globalThis as ScannerGlobal;
  root.__bitgetAiScannerRuntime ??= { lastScan: null };
  return root.__bitgetAiScannerRuntime;
}
