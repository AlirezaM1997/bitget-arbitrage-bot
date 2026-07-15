export const AI_AUTOPILOT_PROFILE_NAMES = ["conservative", "balanced", "active"] as const;

export type AiAutopilotProfile = (typeof AI_AUTOPILOT_PROFILE_NAMES)[number];

type TechnicalPreset = {
  scannerLevels: number;
  scannerLevelWeightDecayPercent: number;
  scannerSampleWindowMs: number;
  scannerMinHistorySamples: number;
  scannerMinPersistenceMs: number;
  scannerMinPersistencePercent: number;
  scannerMinConfidencePercent: number;
  scannerMinVisibleDepthToman: number;
  scannerMaxSpreadBps: number;
  scannerMaxPriceImpactBps: number;
  scannerDepthUsagePercent: number;
  scannerMinImbalanceRatio: number;
  scannerMinOrderFlowImbalance: number;
  scannerMinLiquidityRetentionPercent: number;
  scannerMinMicropriceBiasBps: number;
  scannerMaxTopLevelSharePercent: number;
  scannerMinExpectedEdgeBps: number;
  minTrainingSamples: number;
  minLiveConfidencePercent: number;
  minPredictionAccuracyPercent: number;
  learningRatePercent: number;
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldMs: number;
  cooldownMs: number;
};

export type AiAutopilotProtectionPolicy = {
  recentTradeWindow: number;
  maxRollingDrawdownPercent: number;
  consecutiveLossLimit: number;
  globalPauseMs: number;
  pairTradeWindow: number;
  pairMinimumTrades: number;
  pairPauseMs: number;
  minimumCapitalFraction: number;
  maximumCapitalFraction: number;
};

export const AI_AUTOPILOT_PROFILES: Record<AiAutopilotProfile, {
  label: string;
  english: string;
  description: string;
  technical: TechnicalPreset;
  protection: AiAutopilotProtectionPolicy;
}> = {
  conservative: {
    label: "آرام",
    english: "Conservative",
    description: "معامله کمتر، شواهد قوی‌تر و توقف طولانی‌تر پس از عملکرد ضعیف.",
    technical: {
      scannerLevels: 8,
      scannerLevelWeightDecayPercent: 60,
      scannerSampleWindowMs: 45_000,
      scannerMinHistorySamples: 8,
      scannerMinPersistenceMs: 5_000,
      scannerMinPersistencePercent: 75,
      scannerMinConfidencePercent: 75,
      scannerMinVisibleDepthToman: 8_000_000,
      scannerMaxSpreadBps: 45,
      scannerMaxPriceImpactBps: 10,
      scannerDepthUsagePercent: 20,
      scannerMinImbalanceRatio: 1.8,
      scannerMinOrderFlowImbalance: 0.06,
      scannerMinLiquidityRetentionPercent: 70,
      scannerMinMicropriceBiasBps: 1,
      scannerMaxTopLevelSharePercent: 50,
      scannerMinExpectedEdgeBps: 40,
      minTrainingSamples: 250,
      minLiveConfidencePercent: 85,
      minPredictionAccuracyPercent: 65,
      learningRatePercent: 0.25,
      takeProfitBps: 70,
      stopLossBps: 140,
      maxHoldMs: 15_000,
      cooldownMs: 180_000
    },
    protection: {
      recentTradeWindow: 20,
      maxRollingDrawdownPercent: 1.5,
      consecutiveLossLimit: 2,
      globalPauseMs: 30 * 60_000,
      pairTradeWindow: 3,
      pairMinimumTrades: 2,
      pairPauseMs: 60 * 60_000,
      minimumCapitalFraction: 0.2,
      maximumCapitalFraction: 0.5
    }
  },
  balanced: {
    label: "متعادل",
    english: "Balanced",
    description: "انتخاب پیشنهادی برای تعادل بین کیفیت فرصت و تعداد معاملات.",
    technical: {
      scannerLevels: 10,
      scannerLevelWeightDecayPercent: 70,
      scannerSampleWindowMs: 30_000,
      scannerMinHistorySamples: 5,
      scannerMinPersistenceMs: 2_500,
      scannerMinPersistencePercent: 65,
      scannerMinConfidencePercent: 65,
      scannerMinVisibleDepthToman: 4_000_000,
      scannerMaxSpreadBps: 60,
      scannerMaxPriceImpactBps: 18,
      scannerDepthUsagePercent: 30,
      scannerMinImbalanceRatio: 1.5,
      scannerMinOrderFlowImbalance: 0.035,
      scannerMinLiquidityRetentionPercent: 60,
      scannerMinMicropriceBiasBps: 0.5,
      scannerMaxTopLevelSharePercent: 60,
      scannerMinExpectedEdgeBps: 20,
      minTrainingSamples: 150,
      minLiveConfidencePercent: 78,
      minPredictionAccuracyPercent: 60,
      learningRatePercent: 0.5,
      takeProfitBps: 90,
      stopLossBps: 160,
      maxHoldMs: 30_000,
      cooldownMs: 90_000
    },
    protection: {
      recentTradeWindow: 20,
      maxRollingDrawdownPercent: 3,
      consecutiveLossLimit: 3,
      globalPauseMs: 15 * 60_000,
      pairTradeWindow: 4,
      pairMinimumTrades: 3,
      pairPauseMs: 30 * 60_000,
      minimumCapitalFraction: 0.35,
      maximumCapitalFraction: 0.75
    }
  },
  active: {
    label: "فعال",
    english: "Active",
    description: "فرصت بیشتر با تحمل نوسان بالاتر؛ محافظ‌های سرمایه همچنان فعال‌اند.",
    technical: {
      scannerLevels: 12,
      scannerLevelWeightDecayPercent: 75,
      scannerSampleWindowMs: 20_000,
      scannerMinHistorySamples: 4,
      scannerMinPersistenceMs: 1_500,
      scannerMinPersistencePercent: 55,
      scannerMinConfidencePercent: 55,
      scannerMinVisibleDepthToman: 2_000_000,
      scannerMaxSpreadBps: 80,
      scannerMaxPriceImpactBps: 25,
      scannerDepthUsagePercent: 40,
      scannerMinImbalanceRatio: 1.25,
      scannerMinOrderFlowImbalance: 0.02,
      scannerMinLiquidityRetentionPercent: 50,
      scannerMinMicropriceBiasBps: 0.25,
      scannerMaxTopLevelSharePercent: 70,
      scannerMinExpectedEdgeBps: 10,
      minTrainingSamples: 100,
      minLiveConfidencePercent: 70,
      minPredictionAccuracyPercent: 55,
      learningRatePercent: 1,
      takeProfitBps: 100,
      stopLossBps: 180,
      maxHoldMs: 45_000,
      cooldownMs: 45_000
    },
    protection: {
      recentTradeWindow: 25,
      maxRollingDrawdownPercent: 5,
      consecutiveLossLimit: 4,
      globalPauseMs: 5 * 60_000,
      pairTradeWindow: 5,
      pairMinimumTrades: 4,
      pairPauseMs: 15 * 60_000,
      minimumCapitalFraction: 0.5,
      maximumCapitalFraction: 1
    }
  }
};

export function applyAiAutopilotProfile<T extends { autopilotProfile: AiAutopilotProfile }>(settings: T): T {
  return {
    ...settings,
    ...AI_AUTOPILOT_PROFILES[settings.autopilotProfile].technical
  };
}

export function inferAiAutopilotProfile(input: unknown): AiAutopilotProfile {
  if (!isRecord(input)) return "balanced";
  const explicit = input.autopilotProfile;
  if (AI_AUTOPILOT_PROFILE_NAMES.includes(explicit as AiAutopilotProfile)) {
    return explicit as AiAutopilotProfile;
  }

  let best: AiAutopilotProfile = "balanced";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const profile of AI_AUTOPILOT_PROFILE_NAMES) {
    const preset = AI_AUTOPILOT_PROFILES[profile].technical;
    let distance = 0;
    let compared = 0;
    for (const [key, expected] of Object.entries(preset)) {
      const actual = numeric(input[key]);
      if (actual === undefined) continue;
      distance += Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
      compared += 1;
    }
    if (compared > 0 && distance / compared < bestDistance) {
      best = profile;
      bestDistance = distance / compared;
    }
  }
  return best;
}

export function recommendAiCapitalToman(input: {
  maximumToman: number;
  probability: number;
  minimumConfidencePercent: number;
  profile: AiAutopilotProfile;
}) {
  const policy = AI_AUTOPILOT_PROFILES[input.profile].protection;
  const threshold = clamp(input.minimumConfidencePercent / 100, 0, 0.99);
  const quality = clamp((input.probability - threshold) / Math.max(0.01, 1 - threshold), 0, 1);
  const fraction = policy.minimumCapitalFraction
    + (policy.maximumCapitalFraction - policy.minimumCapitalFraction) * quality;
  return Math.max(0, finite(input.maximumToman) * fraction);
}

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finite(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
