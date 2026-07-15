import { z } from "zod";
import { AI_FEATURE_NAMES } from "../types";
import {
  AI_OFFLINE_FEATURE_CONTRACT_HASH,
  AI_OFFLINE_FEATURE_CONTRACT_ID
} from "./contract";
import {
  AI_OFFLINE_DATASET_VERSION,
  type OfflineDatasetManifest,
  type OfflineTrainingSample
} from "./types";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.number().int().safe().nonnegative();
const shortText = z.string().trim().min(1).max(300);
const featuresSchema = z.object(Object.fromEntries(
  AI_FEATURE_NAMES.map(name => [name, z.number().finite().min(-5).max(5)])
) as Record<(typeof AI_FEATURE_NAMES)[number], z.ZodNumber>).strict();

export const offlineDatasetManifestSchema = z.object({
  schemaVersion: z.literal(AI_OFFLINE_DATASET_VERSION),
  datasetId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
  createdAt: timestampSchema,
  source: z.object({
    provider: shortText,
    dataset: shortText,
    url: z.string().url().max(2_000),
    license: shortText,
    retrievedAt: timestampSchema,
    contentSha256: hashSchema
  }).strict(),
  market: z.object({
    venue: shortText,
    symbol: shortText,
    baseAsset: shortText,
    quoteAsset: shortText,
    marketType: z.enum(["spot", "perpetual", "other"])
  }).strict(),
  coverage: z.object({
    startAt: timestampSchema,
    endAt: timestampSchema,
    recordCount: z.number().int().positive().safe()
  }).strict(),
  labels: z.object({
    horizonMs: z.number().int().positive().safe(),
    policy: z.string().trim().min(1).max(1_000),
    executableCostsIncluded: z.boolean()
  }).strict(),
  featureContract: z.object({
    id: z.literal(AI_OFFLINE_FEATURE_CONTRACT_ID),
    sha256: z.literal(AI_OFFLINE_FEATURE_CONTRACT_HASH)
  }).strict()
}).strict().superRefine((manifest, context) => {
  if (manifest.coverage.endAt < manifest.coverage.startAt) {
    context.addIssue({ code: "custom", path: ["coverage", "endAt"], message: "Coverage cannot end before it starts" });
  }
});

export const offlineTrainingSampleSchema = z.object({
  id: z.string().trim().min(1).max(200),
  observedAt: timestampSchema,
  outcomeAt: timestampSchema,
  sequence: z.number().int().safe().nonnegative().optional(),
  features: featuresSchema,
  label: z.union([z.literal(0), z.literal(1)]),
  netPnlBps: z.number().finite().min(-100_000).max(100_000)
}).strict().superRefine((sample, context) => {
  if (sample.outcomeAt < sample.observedAt) {
    context.addIssue({ code: "custom", path: ["outcomeAt"], message: "Outcome cannot precede observation" });
  }
});

export function validateOfflineDataset(
  manifestInput: unknown,
  samplesInput: unknown
): { manifest: OfflineDatasetManifest; samples: OfflineTrainingSample[] } {
  const manifest = offlineDatasetManifestSchema.parse(manifestInput) as OfflineDatasetManifest;
  const samples = z.array(offlineTrainingSampleSchema).min(3).parse(samplesInput) as OfflineTrainingSample[];
  if (samples.length !== manifest.coverage.recordCount) {
    throw new Error(`Dataset record count mismatch: manifest=${manifest.coverage.recordCount}, samples=${samples.length}`);
  }
  const ids = new Set<string>();
  for (const sample of samples) {
    if (ids.has(sample.id)) throw new Error(`Duplicate offline sample id: ${sample.id}`);
    ids.add(sample.id);
    if (sample.observedAt < manifest.coverage.startAt || sample.observedAt > manifest.coverage.endAt) {
      throw new Error(`Offline sample ${sample.id} is outside manifest coverage`);
    }
    if (sample.outcomeAt - sample.observedAt !== manifest.labels.horizonMs) {
      throw new Error(`Offline sample ${sample.id} does not match the manifest label horizon`);
    }
  }
  return { manifest: structuredClone(manifest), samples: sortOfflineSamples(samples) };
}

export function sortOfflineSamples(samples: readonly OfflineTrainingSample[]) {
  return samples.map(sample => structuredClone(sample)).sort((left, right) =>
    left.observedAt - right.observedAt
    || (left.sequence ?? 0) - (right.sequence ?? 0)
    || left.id.localeCompare(right.id)
  );
}
