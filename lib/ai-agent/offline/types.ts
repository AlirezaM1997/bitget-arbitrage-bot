import type { AiFeatureName, AiFeatures } from "../types";

export const AI_OFFLINE_DATASET_VERSION = 1 as const;
export const AI_OFFLINE_ARTIFACT_VERSION = 1 as const;

export type OfflineDatasetManifest = {
  schemaVersion: typeof AI_OFFLINE_DATASET_VERSION;
  datasetId: string;
  createdAt: number;
  source: {
    provider: string;
    dataset: string;
    url: string;
    license: string;
    retrievedAt: number;
    contentSha256: string;
  };
  market: {
    venue: string;
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    marketType: "spot" | "perpetual" | "other";
  };
  coverage: {
    startAt: number;
    endAt: number;
    recordCount: number;
  };
  labels: {
    horizonMs: number;
    policy: string;
    executableCostsIncluded: boolean;
  };
  featureContract: {
    id: string;
    sha256: string;
  };
};

export type OfflineTrainingSample = {
  id: string;
  observedAt: number;
  outcomeAt: number;
  sequence?: number;
  features: AiFeatures;
  label: 0 | 1;
  /** Executable, cost-adjusted outcome used for economic evaluation. */
  netPnlBps: number;
};

export type OfflineSplitConfig = {
  validationFraction: number;
  testFraction: number;
  purgeMs: number;
  embargoMs: number;
};

export type OfflineDatasetSplit = {
  train: OfflineTrainingSample[];
  validation: OfflineTrainingSample[];
  test: OfflineTrainingSample[];
  boundaries: {
    validationBoundaryAt: number;
    testBoundaryAt: number;
  };
  excluded: {
    purged: number;
    embargoed: number;
  };
};

export type OfflineCandidateParameters = {
  weights: Record<AiFeatureName, number>;
  bias: number;
};

export type OfflineEvaluationMetrics = {
  samples: number;
  selectedTrades: number;
  accuracy: number;
  balancedAccuracy: number;
  precision: number;
  brierScore: number;
  netPnlBps: number;
  maxDrawdownBps: number;
};

export type OfflineTrainingConfig = {
  epochs: number;
  learningRatePercent: number;
  decisionThreshold: number;
  split: OfflineSplitConfig;
};

export type OfflineModelArtifact = {
  schemaVersion: typeof AI_OFFLINE_ARTIFACT_VERSION;
  artifactId: string;
  status: "candidate";
  createdAt: number;
  featureContract: {
    id: string;
    sha256: string;
  };
  dataset: {
    datasetId: string;
    manifestSha256: string;
    externalSampleCount: number;
    sourceProvider: string;
    sourceContentSha256: string;
  };
  split: {
    config: OfflineSplitConfig;
    trainSamples: number;
    validationSamples: number;
    testSamples: number;
    purgedSamples: number;
    embargoedSamples: number;
    validationBoundaryAt: number;
    testBoundaryAt: number;
  };
  training: {
    trainer: "bounded-logistic-v1";
    epochs: number;
    learningRatePercent: number;
    decisionThreshold: number;
  };
  model: OfflineCandidateParameters;
  metrics: {
    train: OfflineEvaluationMetrics;
    validation: OfflineEvaluationMetrics;
    test: OfflineEvaluationMetrics;
  };
  isolation: {
    currentStateMutated: false;
    currentTrainingSamplesAdded: 0;
    promotionRequired: true;
  };
  checksum: {
    algorithm: "sha256";
    value: string;
  };
};
