import type { AiAgentMode } from "./settings";

export const AI_AGENT_STATE_VERSION = 1 as const;

export const AI_FEATURE_NAMES = [
  "expectedEdge",
  "confidence",
  "orderFlow",
  "microprice",
  "retention",
  "spread",
  "impact",
  "roundTripCost",
  "persistence",
  "kind"
] as const;

export type AiFeatureName = (typeof AI_FEATURE_NAMES)[number];
export type AiFeatures = Record<AiFeatureName, number>;
export type AiSignalKind = "autonomous-market" | "orderbook-gap" | "orderbook-imbalance";

export type AiModelState = {
  weights: Record<AiFeatureName, number>;
  bias: number;
  trainingSamples: number;
  correctPredictions: number;
  brierScoreSum: number;
  modelVersion: number;
};

export type AiDemoPosition = {
  id: string;
  kind: AiSignalKind;
  signalId: string;
  symbol: string;
  openedAt: number;
  inputToman: number;
  assetAmount: number;
  entryAveragePrice: number;
  lastMarkedOutputToman: number;
  predictionProbability: number;
  features: AiFeatures;
  modelVersion?: number;
  learningOnly?: boolean;
};

export type AiDemoTrade = {
  id: string;
  kind: AiSignalKind;
  signalId: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  inputToman: number;
  outputToman: number;
  pnlToman: number;
  pnlBps: number;
  exitReason: string;
  predictionProbability: number;
  features: AiFeatures;
  modelVersion?: number;
  learningOnly?: boolean;
};

export type AiDecision = {
  id: string;
  at: number;
  mode: AiAgentMode;
  action: string;
  kind?: AiSignalKind;
  symbol?: string;
  probability?: number;
  detail?: string;
};

export type AiDemoState = {
  initialCapitalToman: number;
  cashToman: number;
  realizedPnlToman: number;
  peakEquityToman: number;
  maxDrawdownToman: number;
  lastEntryAt: number | null;
  openPositions: AiDemoPosition[];
  recentTrades: AiDemoTrade[];
};

export type AiAgentState = {
  version: typeof AI_AGENT_STATE_VERSION;
  model: AiModelState;
  demo: AiDemoState;
  decisions: AiDecision[];
  updatedAt: number;
};
