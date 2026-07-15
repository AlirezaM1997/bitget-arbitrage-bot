import type { StrategySignal } from "@/lib/strategies/types";
import {
  AI_FEATURE_NAMES,
  type AiFeatureName,
  type AiFeatures,
  type AiModelState
} from "./types";

export { AI_FEATURE_NAMES } from "./types";

const LINEAR_CLAMP = 30;
const WEIGHT_CLAMP = 8;
const FEATURE_CLAMP = 5;

export function createDefaultAiModel(): AiModelState {
  return {
    weights: zeroWeights(),
    bias: 0,
    trainingSamples: 0,
    correctPredictions: 0,
    brierScoreSum: 0,
    modelVersion: 1
  };
}

/**
 * Converts the existing deterministic strategy evidence into a fixed,
 * bounded feature vector. Scaling is intentionally part of the feature
 * contract so a persisted model cannot silently change interpretation.
 */
export function extractAiFeatures(signal: StrategySignal): AiFeatures {
  const metrics = signal.metrics;
  const impact = Math.max(
    nonNegativeMetric(metrics, "priceImpactBps"),
    nonNegativeMetric(metrics, "entryPriceImpactBps"),
    nonNegativeMetric(metrics, "exitPriceImpactBps")
  );
  const retention = firstFiniteMetric(metrics, [
    "dominantLiquidityRetentionPercent",
    "bidLiquidityRetentionPercent"
  ]);
  const roundTripCost = firstFiniteMetric(metrics, [
    "projectedRoundTripCostBps",
    "currentRoundTripCostBps"
  ]);

  return sanitizeAiFeatures({
    expectedEdge: scaleSigned(decimalNumber(signal.expectedEdgeBps), 100),
    confidence: clamp(decimalNumber(signal.confidence) / 100, 0, 1),
    orderFlow: clamp(firstFiniteMetric(metrics, ["normalizedOrderFlow"]), -2, 2),
    microprice: scaleSigned(firstFiniteMetric(metrics, ["micropriceBiasBps"]), 10),
    retention: clamp(retention / 100, 0, 1),
    spread: clamp(nonNegativeMetric(metrics, "spreadBps") / 100, 0, FEATURE_CLAMP),
    impact: clamp(impact / 100, 0, FEATURE_CLAMP),
    roundTripCost: clamp(Math.max(0, roundTripCost) / 100, 0, FEATURE_CLAMP),
    persistence: clamp(nonNegativeMetric(metrics, "persistenceMs") / 10_000, 0, FEATURE_CLAMP),
    kind: signal.kind === "orderbook-imbalance" ? 1 : -1
  });
}

export function predictAiProbability(model: AiModelState, features: AiFeatures) {
  const safeFeatures = sanitizeAiFeatures(features);
  let linear = finiteOr(model.bias, 0);
  for (const name of AI_FEATURE_NAMES) {
    linear += finiteOr(model.weights[name], 0) * safeFeatures[name];
  }
  const bounded = clamp(linear, -LINEAR_CLAMP, LINEAR_CLAMP);
  return 1 / (1 + Math.exp(-bounded));
}

/**
 * Performs a prequential update: accuracy and Brier score are recorded from
 * the supplied prediction before any weight is changed. PnL magnitude only
 * provides a bounded sample weight and can never create an unbounded step.
 */
export function updateAiModel(
  model: AiModelState,
  features: AiFeatures,
  probability: number,
  label: 0 | 1,
  learningRatePercent: number,
  pnlBps: number
): AiModelState {
  if (label !== 0 && label !== 1) throw new Error("AI model label must be 0 or 1");
  const prequentialProbability = clamp(finiteOr(probability, 0.5), 0, 1);
  const learningRate = clamp(finiteOr(learningRatePercent, 0) / 100, 0.000_001, 1);
  const sampleWeight = clamp(Math.abs(finiteOr(pnlBps, 0)) / 100, 0.25, 2);
  const error = label - prequentialProbability;
  const step = learningRate * sampleWeight * error;
  const safeFeatures = sanitizeAiFeatures(features);
  const weights = {} as Record<AiFeatureName, number>;
  for (const name of AI_FEATURE_NAMES) {
    weights[name] = clamp(finiteOr(model.weights[name], 0) + step * safeFeatures[name], -WEIGHT_CLAMP, WEIGHT_CLAMP);
  }
  const predictedLabel: 0 | 1 = prequentialProbability >= 0.5 ? 1 : 0;
  const brierScore = (prequentialProbability - label) ** 2;
  return {
    weights,
    bias: clamp(finiteOr(model.bias, 0) + step, -WEIGHT_CLAMP, WEIGHT_CLAMP),
    trainingSamples: nonNegativeInteger(model.trainingSamples) + 1,
    correctPredictions: nonNegativeInteger(model.correctPredictions) + (predictedLabel === label ? 1 : 0),
    brierScoreSum: Math.max(0, finiteOr(model.brierScoreSum, 0)) + brierScore,
    modelVersion: Math.max(1, nonNegativeInteger(model.modelVersion)) + 1
  };
}

export function sanitizeAiFeatures(input: AiFeatures): AiFeatures {
  const features = {} as AiFeatures;
  for (const name of AI_FEATURE_NAMES) {
    features[name] = clamp(finiteOr(input[name], 0), -FEATURE_CLAMP, FEATURE_CLAMP);
  }
  return features;
}

function zeroWeights() {
  return Object.fromEntries(AI_FEATURE_NAMES.map(name => [name, 0])) as Record<AiFeatureName, number>;
}

function firstFiniteMetric(metrics: StrategySignal["metrics"], names: string[]) {
  for (const name of names) {
    const value = metrics[name];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function nonNegativeMetric(metrics: StrategySignal["metrics"], name: string) {
  return Math.max(0, firstFiniteMetric(metrics, [name]));
}

function decimalNumber(value: { toString(): string }) {
  return finiteOr(Number(value.toString()), 0);
}

function scaleSigned(value: number, divisor: number) {
  return clamp(value / divisor, -FEATURE_CLAMP, FEATURE_CLAMP);
}

function nonNegativeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
