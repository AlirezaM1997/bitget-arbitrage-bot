import type { OrderBook } from "@/lib/exchanges/types";
import type {
  OfflineDatasetManifest,
  OfflineModelArtifact,
  OfflineTrainingSample
} from "@/lib/ai-agent/offline";

export const TARDIS_BINANCE_ALLOWED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
export type TardisBinanceAllowedSymbol = (typeof TARDIS_BINANCE_ALLOWED_SYMBOLS)[number];

export type TardisTrainingRequest = {
  symbol: TardisBinanceAllowedSymbol;
  date: string;
  minutes: number;
  sampleIntervalMs: 1_000 | 2_000;
  horizonMs: 5_000 | 10_000 | 30_000;
};

export type TardisTrainingEconomics = {
  capitalToman: number;
  tomanTakerFeeBps: number;
  slippageBps: number;
  depthUsagePercent: number;
  levels: number;
  levelWeightDecayPercent: number;
  quoteScaleTomanPerUsdt?: number;
};

export type TardisReplaySnapshot = {
  observedAt: number;
  book: OrderBook;
};

export type TardisReplayResult = {
  snapshots: TardisReplaySnapshot[];
  contentSha256: string;
  sourceUrls: string[];
  stats: {
    downloadedMinutes: number;
    downloadedBytes: number;
    parsedMessages: number;
    depthUpdates: number;
    generatedSnapshots: number;
    emittedSnapshots: number;
  };
};

export type TardisOfflineDataset = {
  manifest: OfflineDatasetManifest;
  samples: OfflineTrainingSample[];
  replay: TardisReplayResult["stats"];
};

export type TardisCandidateTrainingResult = {
  artifact: Readonly<OfflineModelArtifact>;
  dataset: TardisOfflineDataset;
};
