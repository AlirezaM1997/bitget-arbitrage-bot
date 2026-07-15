import { AI_FEATURE_NAMES, type AiFeatures } from "../types";
import type {
  OfflineCandidateParameters,
  OfflineEvaluationMetrics,
  OfflineTrainingSample
} from "./types";

const LINEAR_CLAMP = 30;

export function predictOfflineProbability(model: OfflineCandidateParameters, features: AiFeatures) {
  let linear = finiteOr(model.bias, 0);
  for (const name of AI_FEATURE_NAMES) {
    linear += finiteOr(model.weights[name], 0) * clamp(finiteOr(features[name], 0), -5, 5);
  }
  return 1 / (1 + Math.exp(-clamp(linear, -LINEAR_CLAMP, LINEAR_CLAMP)));
}

export function evaluateOfflineCandidate(
  model: OfflineCandidateParameters,
  samples: readonly OfflineTrainingSample[],
  decisionThreshold: number
): OfflineEvaluationMetrics {
  if (samples.length === 0) throw new Error("Cannot evaluate an empty offline sample set");
  const threshold = clamp(finiteOr(decisionThreshold, 0.5), 0.01, 0.99);
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let brierSum = 0;
  let netPnlBps = 0;
  let peakPnlBps = 0;
  let maxDrawdownBps = 0;
  let selectedTrades = 0;
  for (const sample of samples) {
    const probability = predictOfflineProbability(model, sample.features);
    const predictedPositive = probability >= threshold;
    if (predictedPositive && sample.label === 1) truePositive += 1;
    else if (predictedPositive) falsePositive += 1;
    else if (sample.label === 0) trueNegative += 1;
    else falseNegative += 1;
    brierSum += (probability - sample.label) ** 2;
    if (predictedPositive) {
      selectedTrades += 1;
      netPnlBps += sample.netPnlBps;
      peakPnlBps = Math.max(peakPnlBps, netPnlBps);
      maxDrawdownBps = Math.max(maxDrawdownBps, peakPnlBps - netPnlBps);
    }
  }
  const positiveRecall = ratio(truePositive, truePositive + falseNegative);
  const negativeRecall = ratio(trueNegative, trueNegative + falsePositive);
  const availableRecalls = [positiveRecall, negativeRecall].filter((value): value is number => value !== undefined);
  return {
    samples: samples.length,
    selectedTrades,
    accuracy: (truePositive + trueNegative) / samples.length,
    balancedAccuracy: availableRecalls.reduce((sum, value) => sum + value, 0) / availableRecalls.length,
    precision: ratio(truePositive, truePositive + falsePositive) ?? 0,
    brierScore: brierSum / samples.length,
    netPnlBps,
    maxDrawdownBps
  };
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : undefined;
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
