import { z } from "zod";
import { AI_FEATURE_NAMES, type AiFeatureName } from "../types";
import {
  AI_OFFLINE_FEATURE_CONTRACT,
  sha256Canonical
} from "./contract";
import { validateOfflineDataset } from "./dataset";
import { calculateOfflineArtifactChecksum, validateOfflineModelArtifact } from "./artifact";
import { evaluateOfflineCandidate, predictOfflineProbability } from "./metrics";
import { DEFAULT_OFFLINE_SPLIT_CONFIG, splitOfflineDataset } from "./split";
import {
  AI_OFFLINE_ARTIFACT_VERSION,
  type OfflineCandidateParameters,
  type OfflineDatasetManifest,
  type OfflineModelArtifact,
  type OfflineTrainingConfig,
  type OfflineTrainingSample
} from "./types";

export const DEFAULT_OFFLINE_TRAINING_CONFIG: OfflineTrainingConfig = Object.freeze({
  epochs: 3,
  learningRatePercent: 2,
  decisionThreshold: 0.5,
  split: DEFAULT_OFFLINE_SPLIT_CONFIG
});

const trainingConfigSchema = z.object({
  epochs: z.number().int().positive().max(100),
  learningRatePercent: z.number().finite().gt(0).max(100),
  decisionThreshold: z.number().finite().min(0.01).max(0.99),
  split: z.object({
    validationFraction: z.number().finite().gt(0).lt(0.5),
    testFraction: z.number().finite().gt(0).lt(0.5),
    purgeMs: z.number().int().safe().nonnegative(),
    embargoMs: z.number().int().safe().nonnegative()
  }).strict()
}).strict();

export type TrainOfflineCandidateInput = {
  manifest: OfflineDatasetManifest;
  samples: OfflineTrainingSample[];
  config?: Partial<Omit<OfflineTrainingConfig, "split">> & { split?: Partial<OfflineTrainingConfig["split"]> };
  /** Injectable for reproducible jobs and tests; never inferred from sample time. */
  createdAt?: number;
};

/**
 * Pure candidate training. It deliberately does not import or call the online
 * AI state store, so external observations cannot increment Live readiness.
 */
export function trainOfflineCandidate(input: TrainOfflineCandidateInput): Readonly<OfflineModelArtifact> {
  const { manifest, samples } = validateOfflineDataset(input.manifest, input.samples);
  if (!manifest.labels.executableCostsIncluded) {
    throw new Error("Offline candidate labels must include executable fees, spread, slippage and price impact");
  }
  const config = trainingConfigSchema.parse({
    ...DEFAULT_OFFLINE_TRAINING_CONFIG,
    ...input.config,
    split: { ...DEFAULT_OFFLINE_SPLIT_CONFIG, ...input.config?.split }
  }) as OfflineTrainingConfig;
  const split = splitOfflineDataset(samples, config.split);
  let model = createEmptyCandidate();
  for (let epoch = 0; epoch < config.epochs; epoch += 1) {
    for (const sample of split.train) model = boundedUpdate(model, sample, config.learningRatePercent);
  }

  const createdAt = validCreatedAt(input.createdAt ?? Date.now());
  const manifestSha256 = sha256Canonical(manifest);
  const fingerprint = sha256Canonical({
    manifestSha256,
    config,
    model,
    split: {
      train: split.train.map(sample => sample.id),
      validation: split.validation.map(sample => sample.id),
      test: split.test.map(sample => sample.id)
    }
  });
  const unsigned: Omit<OfflineModelArtifact, "checksum"> = {
    schemaVersion: AI_OFFLINE_ARTIFACT_VERSION,
    artifactId: `${manifest.datasetId}-${fingerprint.slice(0, 20)}`,
    status: "candidate",
    createdAt,
    featureContract: { ...AI_OFFLINE_FEATURE_CONTRACT },
    dataset: {
      datasetId: manifest.datasetId,
      manifestSha256,
      externalSampleCount: samples.length,
      sourceProvider: manifest.source.provider,
      sourceContentSha256: manifest.source.contentSha256
    },
    split: {
      config: structuredClone(config.split),
      trainSamples: split.train.length,
      validationSamples: split.validation.length,
      testSamples: split.test.length,
      purgedSamples: split.excluded.purged,
      embargoedSamples: split.excluded.embargoed,
      validationBoundaryAt: split.boundaries.validationBoundaryAt,
      testBoundaryAt: split.boundaries.testBoundaryAt
    },
    training: {
      trainer: "bounded-logistic-v1",
      epochs: config.epochs,
      learningRatePercent: config.learningRatePercent,
      decisionThreshold: config.decisionThreshold
    },
    model,
    metrics: {
      train: evaluateOfflineCandidate(model, split.train, config.decisionThreshold),
      validation: evaluateOfflineCandidate(model, split.validation, config.decisionThreshold),
      test: evaluateOfflineCandidate(model, split.test, config.decisionThreshold)
    },
    isolation: {
      currentStateMutated: false,
      currentTrainingSamplesAdded: 0,
      promotionRequired: true
    }
  };
  const artifact: OfflineModelArtifact = {
    ...unsigned,
    checksum: { algorithm: "sha256", value: calculateOfflineArtifactChecksum(unsigned) }
  };
  return validateOfflineModelArtifact(artifact);
}

function createEmptyCandidate(): OfflineCandidateParameters {
  return {
    weights: Object.fromEntries(AI_FEATURE_NAMES.map(name => [name, 0])) as Record<AiFeatureName, number>,
    bias: 0
  };
}

function boundedUpdate(
  model: OfflineCandidateParameters,
  sample: OfflineTrainingSample,
  learningRatePercent: number
): OfflineCandidateParameters {
  const probability = predictOfflineProbability(model, sample.features);
  const learningRate = clamp(learningRatePercent / 100, 0.000_001, 1);
  const sampleWeight = clamp(Math.abs(sample.netPnlBps) / 100, 0.25, 2);
  const step = learningRate * sampleWeight * (sample.label - probability);
  const weights = {} as Record<AiFeatureName, number>;
  for (const name of AI_FEATURE_NAMES) {
    weights[name] = clamp(model.weights[name] + step * clamp(sample.features[name], -5, 5), -8, 8);
  }
  return { weights, bias: clamp(model.bias + step, -8, 8) };
}

function validCreatedAt(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Offline artifact creation time must be a non-negative safe integer");
  return value;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
