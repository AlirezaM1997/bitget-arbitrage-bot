import { z } from "zod";
import { defaultStrategyLabSettings, strategyLabSettingsSchema } from "./strategy-settings";
import { aiAgentSettingsSchema, defaultAiAgentSettings } from "./ai-agent/settings";

export const botSettingsSchema = z.object({
  bitgetAccountMode: z.enum(["classic", "uta"]).default("uta"),
  bitgetDemoTrading: z.boolean().default(false),
  paperCapitalToman: z.coerce.number().positive().max(1_000_000_000_000_000),
  maxTradeToman: z.coerce.number().positive().max(1_000_000_000_000_000),
  balanceUsagePercent: z.coerce.number().positive().max(100),
  tomanTakerFeeBps: z.coerce.number().min(0).max(10_000),
  usdtTakerFeeBps: z.coerce.number().min(0).max(10_000),
  slippageBufferBps: z.coerce.number().min(0).max(9_000),
  liveSafetyBufferBps: z.coerce.number().min(0).max(10_000).default(150),
  maxPriceImpactBps: z.coerce.number().min(0).max(10_000).default(25),
  maxSpreadBps: z.coerce.number().min(0).max(10_000).default(80),
  orderbookDepthUsagePercent: z.coerce.number().positive().max(100).default(40),
  minProfitBps: z.coerce.number().min(0).max(100_000),
  minNetProfitToman: z.coerce.number().min(0).max(1_000_000_000_000_000),
  orderbookMaxAgeMs: z.coerce.number().int().min(1_000).max(300_000),
  scanIntervalMs: z.coerce.number().int().min(1_000).max(3_600_000),
  orderTimeoutMs: z.coerce.number().int().min(1_000).max(300_000),
  strategyLab: strategyLabSettingsSchema.default(defaultStrategyLabSettings),
  aiAgent: aiAgentSettingsSchema.default(defaultAiAgentSettings)
});

export type BotSettings = z.infer<typeof botSettingsSchema>;

export const defaultBotSettings: BotSettings = {
  bitgetAccountMode: "uta",
  bitgetDemoTrading: false,
  paperCapitalToman: 1_000,
  maxTradeToman: 50,
  balanceUsagePercent: 10,
  tomanTakerFeeBps: 20,
  usdtTakerFeeBps: 20,
  slippageBufferBps: 5,
  liveSafetyBufferBps: 10,
  maxPriceImpactBps: 15,
  maxSpreadBps: 25,
  orderbookDepthUsagePercent: 30,
  minProfitBps: 15,
  minNetProfitToman: 0.1,
  orderbookMaxAgeMs: 1_500,
  scanIntervalMs: 1_000,
  orderTimeoutMs: 4_000,
  strategyLab: defaultStrategyLabSettings,
  aiAgent: defaultAiAgentSettings
};
