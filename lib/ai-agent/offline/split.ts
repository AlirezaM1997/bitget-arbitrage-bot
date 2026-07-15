import { z } from "zod";
import { sortOfflineSamples } from "./dataset";
import type {
  OfflineDatasetSplit,
  OfflineSplitConfig,
  OfflineTrainingSample
} from "./types";

export const DEFAULT_OFFLINE_SPLIT_CONFIG: OfflineSplitConfig = Object.freeze({
  validationFraction: 0.2,
  testFraction: 0.2,
  purgeMs: 30_000,
  embargoMs: 30_000
});

const splitConfigSchema = z.object({
  validationFraction: z.number().finite().gt(0).lt(0.5),
  testFraction: z.number().finite().gt(0).lt(0.5),
  purgeMs: z.number().int().safe().nonnegative(),
  embargoMs: z.number().int().safe().nonnegative()
}).strict().superRefine((config, context) => {
  if (config.validationFraction + config.testFraction >= 0.8) {
    context.addIssue({ code: "custom", message: "At least 20% of observations must remain available for training" });
  }
});

/**
 * Makes chronological splits and removes both label-horizon overlap (purge)
 * and the configured cool-off window after each boundary (embargo).
 */
export function splitOfflineDataset(
  input: readonly OfflineTrainingSample[],
  configInput: OfflineSplitConfig = DEFAULT_OFFLINE_SPLIT_CONFIG
): OfflineDatasetSplit {
  const config = splitConfigSchema.parse(configInput);
  if (input.length < 6) throw new Error("At least six samples are required for chronological train/validation/test splits");
  const samples = sortOfflineSamples(input);
  let validationIndex = Math.floor(samples.length * (1 - config.validationFraction - config.testFraction));
  let testIndex = Math.floor(samples.length * (1 - config.testFraction));
  validationIndex = moveBoundaryPastTimestamp(samples, validationIndex);
  testIndex = moveBoundaryPastTimestamp(samples, Math.max(testIndex, validationIndex + 1));
  if (validationIndex < 1 || testIndex <= validationIndex || testIndex >= samples.length) {
    throw new Error("Dataset timestamps cannot produce three distinct chronological segments");
  }

  const validationBoundaryAt = samples[validationIndex]!.observedAt;
  const testBoundaryAt = samples[testIndex]!.observedAt;
  const rawTrain = samples.slice(0, validationIndex);
  const rawValidation = samples.slice(validationIndex, testIndex);
  const rawTest = samples.slice(testIndex);

  const train = rawTrain.filter(sample => sample.outcomeAt < validationBoundaryAt - config.purgeMs);
  const validationAfterEmbargo = rawValidation.filter(sample => sample.observedAt >= validationBoundaryAt + config.embargoMs);
  const validation = validationAfterEmbargo.filter(sample => sample.outcomeAt < testBoundaryAt - config.purgeMs);
  const test = rawTest.filter(sample => sample.observedAt >= testBoundaryAt + config.embargoMs);

  if (train.length === 0 || validation.length === 0 || test.length === 0) {
    throw new Error("Purge/embargo settings leave an empty chronological split");
  }
  const purged = (rawTrain.length - train.length) + (validationAfterEmbargo.length - validation.length);
  const embargoed = (rawValidation.length - validationAfterEmbargo.length) + (rawTest.length - test.length);
  return {
    train,
    validation,
    test,
    boundaries: { validationBoundaryAt, testBoundaryAt },
    excluded: { purged, embargoed }
  };
}

function moveBoundaryPastTimestamp(samples: readonly OfflineTrainingSample[], requested: number) {
  let index = Math.max(1, Math.min(samples.length - 1, requested));
  while (index < samples.length && samples[index]!.observedAt === samples[index - 1]!.observedAt) index += 1;
  return index;
}
