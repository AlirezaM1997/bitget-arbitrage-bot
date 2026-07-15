import {
  trainOfflineCandidate,
  writeOfflineModelArtifact
} from "@/lib/ai-agent/offline";
import { buildTardisOfflineDataset, type BuildTardisOfflineDatasetOptions } from "./dataset-builder";
import type {
  TardisCandidateTrainingResult,
  TardisTrainingEconomics,
  TardisTrainingRequest
} from "./types";

export type TrainTardisCandidateOptions = BuildTardisOfflineDatasetOptions & {
  artifactDirectory?: string;
};

/**
 * Creates and persists an immutable Candidate artifact. This module has no
 * dependency on the online AI store and exposes no activation/promotion path.
 */
export async function trainTardisCandidate(
  request: TardisTrainingRequest,
  economics: TardisTrainingEconomics,
  options: TrainTardisCandidateOptions = {}
): Promise<TardisCandidateTrainingResult> {
  const dataset = await buildTardisOfflineDataset(request, economics, options);
  const createdAt = options.now ?? Date.now();
  const artifact = trainOfflineCandidate({
    manifest: dataset.manifest,
    samples: dataset.samples,
    createdAt,
    config: {
      epochs: 4,
      learningRatePercent: 2,
      decisionThreshold: 0.55,
      split: {
        validationFraction: 0.2,
        testFraction: 0.2,
        // Prevent target leakage without erasing short free-sample segments.
        purgeMs: request.horizonMs,
        embargoMs: request.sampleIntervalMs
      }
    }
  });
  await writeOfflineModelArtifact(artifact as typeof artifact, options.artifactDirectory);
  return { artifact, dataset };
}
