import { z } from "zod";

const boundedBps = z.coerce.number().min(0).max(10_000);
const positiveBps = z.coerce.number().positive().max(10_000);
const capital = z.coerce.number().positive().max(1_000_000_000_000_000);

export const strategyLabSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  gapTrading: z.object({
    enabled: z.boolean().default(false),
    levels: z.coerce.number().int().min(4).max(25).default(10),
    baselineLevels: z.coerce.number().int().min(4).max(50).default(20),
    minGapBps: positiveBps.default(120),
    minGapZScore: z.coerce.number().min(1).max(20).default(3),
    minGapRatio: z.coerce.number().min(1).max(100).default(4),
    sampleWindowMs: z.coerce.number().int().min(2_000).max(120_000).default(60_000),
    minPersistenceMs: z.coerce.number().int().min(0).max(60_000).default(3_000),
    maxPersistenceMs: z.coerce.number().int().min(2_000).max(120_000).default(45_000),
    minConfirmations: z.coerce.number().int().min(2).max(30).default(4),
    maxGapDriftPercent: z.coerce.number().min(0).max(100).default(30),
    maxBoundaryDriftBps: boundedBps.max(2_000).default(20),
    levelWeightDecayPercent: z.coerce.number().min(10).max(100).default(70),
    minFlowSamples: z.coerce.number().int().min(0).max(20).default(2),
    minOrderFlowImbalance: z.coerce.number().min(0).max(2).default(0.02),
    minBidLiquidityRetentionPercent: z.coerce.number().min(0).max(100).default(60),
    minBidSupportRatio: z.coerce.number().min(1).max(100).default(1.4),
    minMicropriceBiasBps: boundedBps.max(500).default(1),
    maxTopLevelSharePercent: z.coerce.number().min(10).max(100).default(55),
    minVisibleDepthToman: capital.default(2_000_000),
    maxSpreadBps: boundedBps.default(80),
    maxPriceImpactBps: boundedBps.default(25),
    depthUsagePercent: z.coerce.number().positive().max(100).default(40),
    capitalToman: capital.default(250_000),
    maxPreGapConsumptionPercent: z.coerce.number().positive().max(100).default(15),
    targetCapturePercent: z.coerce.number().positive().max(75).default(35),
    minProjectedNetBps: boundedBps.default(40),
    safetyBufferBps: boundedBps.default(30),
    predictionHorizonMs: z.coerce.number().int().min(500).max(60_000).default(3_000),
    minOutcomeSamples: z.coerce.number().int().min(10).max(60).default(20),
    minOutcomeHitRatePercent: z.coerce.number().min(50).max(100).default(60),
    minPredictedNetBps: boundedBps.max(2_000).default(40),
    forecastSafetyBps: boundedBps.max(2_000).default(30),
    takeProfitBps: positiveBps.default(100),
    stopLossBps: positiveBps.default(100),
    maxLossToman: capital.default(7_500),
    maxResidualToman: capital.default(1_000),
    maxHoldMs: z.coerce.number().int().min(5_000).max(240_000).default(30_000),
    pollIntervalMs: z.coerce.number().int().min(250).max(10_000).default(1_000),
    cooldownMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
    orderReserveBps: boundedBps.max(2_000).default(20),
    recoveryMaxSpreadBps: boundedBps.default(1_000),
    recoveryMaxPriceImpactBps: boundedBps.default(1_000),
    recoverySlippageBps: boundedBps.max(2_000).default(100)
  }).default({}),
  imbalance: z.object({
    enabled: z.boolean().default(false),
    levels: z.coerce.number().int().min(1).max(25).default(5),
    levelWeightDecayPercent: z.coerce.number().min(10).max(100).default(70),
    minRatio: z.coerce.number().min(1).max(100).default(2.5),
    exitRatio: z.coerce.number().min(1).max(100).default(1.25),
    sampleWindowMs: z.coerce.number().int().min(2_000).max(300_000).default(60_000),
    minPersistenceMs: z.coerce.number().int().min(0).max(30_000).default(2_000),
    maxPersistenceMs: z.coerce.number().int().min(2_000).max(60_000).default(12_000),
    minConfirmations: z.coerce.number().int().min(1).max(20).default(3),
    predictionHorizonMs: z.coerce.number().int().min(500).max(60_000).default(3_000),
    minOutcomeSamples: z.coerce.number().int().min(10).max(40).default(30),
    minOutcomeHitRatePercent: z.coerce.number().min(50).max(100).default(60),
    minPredictedNetBps: boundedBps.max(2_000).default(40),
    forecastSafetyBps: boundedBps.max(2_000).default(30),
    minPressureDelta: z.coerce.number().min(0).max(2).default(0.08),
    minFlowSamples: z.coerce.number().int().min(0).max(20).default(2),
    minOrderFlowImbalance: z.coerce.number().min(0).max(2).default(0.03),
    minDominantLiquidityRetentionPercent: z.coerce.number().min(0).max(100).default(60),
    maxTopLevelSharePercent: z.coerce.number().min(10).max(100).default(70),
    minMicropriceBiasBps: boundedBps.max(500).default(0.5),
    maxAdverseMoveBps: boundedBps.max(2_000).default(15),
    maxSpreadBps: boundedBps.default(100),
    maxPriceImpactBps: boundedBps.default(40),
    minVisibleDepthToman: capital.default(2_000_000),
    depthUsagePercent: z.coerce.number().positive().max(100).default(60),
    capitalToman: capital.default(250_000),
    takeProfitBps: positiveBps.default(100),
    stopLossBps: positiveBps.default(80),
    maxLossToman: capital.default(7_500),
    maxResidualToman: capital.default(1_000),
    maxHoldMs: z.coerce.number().int().min(5_000).max(240_000).default(30_000),
    pollIntervalMs: z.coerce.number().int().min(250).max(10_000).default(1_000),
    cooldownMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
    orderReserveBps: boundedBps.max(2_000).default(20),
    recoveryMaxSpreadBps: boundedBps.default(1_000),
    recoveryMaxPriceImpactBps: boundedBps.default(1_000),
    recoverySlippageBps: boundedBps.max(2_000).default(100)
  }).default({}),
  spotEasy: z.object({
    enabled: z.boolean().default(false),
    minEdgeBps: boundedBps.default(100),
    quoteExpiryBufferMs: z.coerce.number().int().min(0).max(60_000).default(2_000)
  }).default({})
}).superRefine((settings, context) => {
  if (settings.imbalance.exitRatio >= settings.imbalance.minRatio) {
    context.addIssue({ code: "custom", path: ["imbalance", "exitRatio"], message: "Exit Imbalance must be below Entry Imbalance" });
  }
  if (settings.imbalance.minPersistenceMs > settings.imbalance.maxPersistenceMs) {
    context.addIssue({ code: "custom", path: ["imbalance", "maxPersistenceMs"], message: "Max Persistence must be at least Min Persistence" });
  }
  if (settings.imbalance.minPersistenceMs > settings.imbalance.sampleWindowMs) {
    context.addIssue({ code: "custom", path: ["imbalance", "sampleWindowMs"], message: "Signal Window must cover Min Persistence" });
  }
  if (settings.gapTrading.minPersistenceMs > settings.gapTrading.maxPersistenceMs) {
    context.addIssue({ code: "custom", path: ["gapTrading", "maxPersistenceMs"], message: "Max Persistence must be at least Min Persistence" });
  }
  if (settings.gapTrading.minPersistenceMs > settings.gapTrading.sampleWindowMs) {
    context.addIssue({ code: "custom", path: ["gapTrading", "sampleWindowMs"], message: "Signal Window must cover Min Persistence" });
  }
});

export type StrategyLabSettings = z.infer<typeof strategyLabSettingsSchema>;

export const defaultStrategyLabSettings: StrategyLabSettings = strategyLabSettingsSchema.parse({});
