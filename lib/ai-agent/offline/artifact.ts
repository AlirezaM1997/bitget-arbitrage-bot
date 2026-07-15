import { z } from "zod";
import { AI_FEATURE_NAMES } from "../types";
import {
  AI_OFFLINE_FEATURE_CONTRACT_HASH,
  AI_OFFLINE_FEATURE_CONTRACT_ID,
  canonicalJson,
  sha256Canonical
} from "./contract";
import {
  AI_OFFLINE_ARTIFACT_VERSION,
  type OfflineModelArtifact
} from "./types";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.number().int().safe().nonnegative();
const countSchema = z.number().int().safe().nonnegative();
const metricSchema = z.object({
  samples: z.number().int().positive().safe(),
  selectedTrades: countSchema,
  accuracy: z.number().finite().min(0).max(1),
  balancedAccuracy: z.number().finite().min(0).max(1),
  precision: z.number().finite().min(0).max(1),
  brierScore: z.number().finite().min(0).max(1),
  netPnlBps: z.number().finite(),
  maxDrawdownBps: z.number().finite().nonnegative()
}).strict().superRefine((metrics, context) => {
  if (metrics.selectedTrades > metrics.samples) {
    context.addIssue({ code: "custom", path: ["selectedTrades"], message: "Selected trades cannot exceed samples" });
  }
});

const artifactSchema = z.object({
  schemaVersion: z.literal(AI_OFFLINE_ARTIFACT_VERSION),
  artifactId: z.string().min(1).max(180).regex(/^[a-zA-Z0-9._-]+$/),
  status: z.literal("candidate"),
  createdAt: timestampSchema,
  featureContract: z.object({
    id: z.literal(AI_OFFLINE_FEATURE_CONTRACT_ID),
    sha256: z.literal(AI_OFFLINE_FEATURE_CONTRACT_HASH)
  }).strict(),
  dataset: z.object({
    datasetId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
    manifestSha256: hashSchema,
    externalSampleCount: z.number().int().positive().safe(),
    sourceProvider: z.string().trim().min(1).max(300),
    sourceContentSha256: hashSchema
  }).strict(),
  split: z.object({
    config: z.object({
      validationFraction: z.number().finite().gt(0).lt(0.5),
      testFraction: z.number().finite().gt(0).lt(0.5),
      purgeMs: countSchema,
      embargoMs: countSchema
    }).strict(),
    trainSamples: z.number().int().positive().safe(),
    validationSamples: z.number().int().positive().safe(),
    testSamples: z.number().int().positive().safe(),
    purgedSamples: countSchema,
    embargoedSamples: countSchema,
    validationBoundaryAt: timestampSchema,
    testBoundaryAt: timestampSchema
  }).strict(),
  training: z.object({
    trainer: z.literal("bounded-logistic-v1"),
    epochs: z.number().int().positive().max(100),
    learningRatePercent: z.number().finite().gt(0).max(100),
    decisionThreshold: z.number().finite().min(0.01).max(0.99)
  }).strict(),
  model: z.object({
    weights: z.object(Object.fromEntries(
      AI_FEATURE_NAMES.map(name => [name, z.number().finite().min(-8).max(8)])
    ) as Record<(typeof AI_FEATURE_NAMES)[number], z.ZodNumber>).strict(),
    bias: z.number().finite().min(-8).max(8)
  }).strict(),
  metrics: z.object({ train: metricSchema, validation: metricSchema, test: metricSchema }).strict(),
  isolation: z.object({
    currentStateMutated: z.literal(false),
    currentTrainingSamplesAdded: z.literal(0),
    promotionRequired: z.literal(true)
  }).strict(),
  checksum: z.object({ algorithm: z.literal("sha256"), value: hashSchema }).strict()
}).strict().superRefine((artifact, context) => {
  const accountedSamples = artifact.split.trainSamples
    + artifact.split.validationSamples
    + artifact.split.testSamples
    + artifact.split.purgedSamples
    + artifact.split.embargoedSamples;
  if (accountedSamples !== artifact.dataset.externalSampleCount) {
    context.addIssue({ code: "custom", path: ["split"], message: "Split accounting must cover every external sample" });
  }
  if (artifact.split.testBoundaryAt <= artifact.split.validationBoundaryAt) {
    context.addIssue({ code: "custom", path: ["split", "testBoundaryAt"], message: "Test boundary must follow validation boundary" });
  }
  for (const name of ["train", "validation", "test"] as const) {
    const expected = artifact.split[`${name}Samples`];
    if (artifact.metrics[name].samples !== expected) {
      context.addIssue({ code: "custom", path: ["metrics", name, "samples"], message: "Metric sample count must match the split" });
    }
  }
});

export function calculateOfflineArtifactChecksum(artifact: Omit<OfflineModelArtifact, "checksum"> | OfflineModelArtifact) {
  const { checksum: _checksum, ...unsigned } = artifact as OfflineModelArtifact;
  return sha256Canonical(unsigned);
}

export function validateOfflineModelArtifact(input: unknown): Readonly<OfflineModelArtifact> {
  const artifact = artifactSchema.parse(input) as OfflineModelArtifact;
  const expected = calculateOfflineArtifactChecksum(artifact);
  if (artifact.checksum.value !== expected) throw new Error("Offline model artifact checksum mismatch");
  return deepFreeze(structuredClone(artifact));
}

export function serializeOfflineModelArtifact(artifact: OfflineModelArtifact) {
  return `${canonicalJson(validateOfflineModelArtifact(artifact))}\n`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
