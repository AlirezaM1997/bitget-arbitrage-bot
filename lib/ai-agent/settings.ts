import { z } from "zod";
import {
  AI_AUTOPILOT_PROFILE_NAMES,
  applyAiAutopilotProfile
} from "./autopilot-profiles";

const tomanCapital = z.coerce.number().finite().positive().max(1_000_000_000_000_000);
const boundedBps = z.coerce.number().finite().positive().max(10_000);

export const aiAgentModeSchema = z.enum(["demo", "live"]);
export const aiAutopilotProfileSchema = z.enum(AI_AUTOPILOT_PROFILE_NAMES);

export const aiAgentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: aiAgentModeSchema.default("demo"),
  autopilotProfile: aiAutopilotProfileSchema.default("balanced"),
  demoCapitalToman: tomanCapital.default(10_000_000),
  demoTradeCapitalToman: tomanCapital.default(250_000),
  maxLiveCapitalToman: tomanCapital.default(250_000),
  scannerLevels: z.coerce.number().int().min(3).max(50).default(10),
  scannerLevelWeightDecayPercent: z.coerce.number().finite().min(10).max(100).default(70),
  scannerSampleWindowMs: z.coerce.number().int().min(3_000).max(300_000).default(30_000),
  scannerMinHistorySamples: z.coerce.number().int().min(2).max(60).default(4),
  scannerMinPersistenceMs: z.coerce.number().int().min(500).max(120_000).default(2_000),
  scannerMinPersistencePercent: z.coerce.number().finite().min(0).max(100).default(60),
  scannerMinConfidencePercent: z.coerce.number().finite().min(0).max(100).default(55),
  scannerMinVisibleDepthToman: tomanCapital.default(2_000_000),
  scannerMaxSpreadBps: boundedBps.default(80),
  scannerMaxPriceImpactBps: boundedBps.default(25),
  scannerDepthUsagePercent: z.coerce.number().finite().positive().max(100).default(40),
  scannerMinImbalanceRatio: z.coerce.number().finite().min(1).max(100).default(1.35),
  scannerMinOrderFlowImbalance: z.coerce.number().finite().min(0).max(2).default(0.02),
  scannerMinLiquidityRetentionPercent: z.coerce.number().finite().min(0).max(100).default(55),
  scannerMinMicropriceBiasBps: z.coerce.number().finite().min(0).max(500).default(0.5),
  scannerMaxTopLevelSharePercent: z.coerce.number().finite().min(10).max(100).default(70),
  scannerMinExpectedEdgeBps: z.coerce.number().finite().min(0).max(10_000).default(20),
  minTrainingSamples: z.coerce.number().int().min(20).max(1_000_000).default(100),
  minLiveConfidencePercent: z.coerce.number().finite().min(50).max(100).default(75),
  minPredictionAccuracyPercent: z.coerce.number().finite().min(50).max(100).default(60),
  learningRatePercent: z.coerce.number().finite().min(0.01).max(100).default(1),
  takeProfitBps: boundedBps.default(100),
  stopLossBps: boundedBps.default(80),
  maxHoldMs: z.coerce.number().int().min(5_000).max(240_000).default(30_000),
  cooldownMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000)
}).strip().superRefine((settings, context) => {
  if (settings.demoTradeCapitalToman > settings.demoCapitalToman) {
    context.addIssue({
      code: "custom",
      path: ["demoTradeCapitalToman"],
      message: "Demo trade capital cannot exceed total Demo capital"
    });
  }
});

export type AiAgentMode = z.infer<typeof aiAgentModeSchema>;
export type AiAutopilotProfile = z.infer<typeof aiAutopilotProfileSchema>;
export type AiAgentSettings = z.infer<typeof aiAgentSettingsSchema>;

export const defaultAiAgentSettings: AiAgentSettings = Object.freeze(
  applyAiAutopilotProfile(aiAgentSettingsSchema.parse({}))
);
