import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { botSettingsSchema, defaultBotSettings, type BotSettings } from "./bot-settings";
import { defaultStrategyLabSettings } from "./strategy-settings";
import { defaultAiAgentSettings } from "./ai-agent/settings";
import {
  applyAiAutopilotProfile,
  inferAiAutopilotProfile
} from "./ai-agent/autopilot-profiles";
import { applyBitgetRuntimeSettings } from "./bitget-runtime-settings";

const settingsPath = path.join(process.cwd(), "data", "bot-settings.json");

export async function getBotSettings(): Promise<BotSettings> {
  try {
    const stored = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const migrated = {
      ...stored,
      bitgetAccountMode: stored.bitgetAccountMode ?? "uta",
      bitgetDemoTrading: stored.bitgetDemoTrading ?? false,
      tomanTakerFeeBps: stored.tomanTakerFeeBps ?? 20,
      usdtTakerFeeBps: stored.usdtTakerFeeBps ?? 20,
      maxPriceImpactBps: stored.maxPriceImpactBps ?? 15,
      maxSpreadBps: stored.maxSpreadBps ?? 25,
      orderbookDepthUsagePercent: stored.orderbookDepthUsagePercent ?? 30,
      liveSafetyBufferBps: stored.liveSafetyBufferBps ?? 10,
      strategyLab: stored.strategyLab === undefined
        ? defaultStrategyLabSettings
        : migrateStoredStrategyLabSettings(stored.strategyLab),
      // Fail closed on upgrades: an old settings file can never opt itself
      // into autonomous Demo or Live execution.
      aiAgent: migrateStoredAiAgentSettings(stored.aiAgent)
    };
    const settings = normalizeAiAutopilot(botSettingsSchema.parse(migrated));
    applyBitgetRuntimeSettings(settings);
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await saveBotSettings(defaultBotSettings);
    return { ...defaultBotSettings };
  }
}

/**
 * Market Making and liquidity-gap trading have different risk semantics. Old
 * values are copied only where they make the analytical model stricter, and the
 * replacement engine is always disabled so an upgrade cannot opt the user in.
 */
export function migrateStoredStrategyLabSettings(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const defaults = defaultStrategyLabSettings.gapTrading;

  if (isRecord(input.gapTrading)) {
    const gap = input.gapTrading;
    const calibrationFields = [
      "predictionHorizonMs",
      "minOutcomeSamples",
      "minOutcomeHitRatePercent",
      "minPredictedNetBps",
      "forecastSafetyBps"
    ];
    if (calibrationFields.every(field => Object.prototype.hasOwnProperty.call(gap, field))) return input;

    // Older Gap settings used a window too short to collect enough independent
    // forward outcomes. Keep every explicit value, but lengthen only the two
    // legacy timing limits needed by the calibrated live gate.
    return {
      ...input,
      gapTrading: {
        ...defaults,
        ...gap,
        sampleWindowMs: Math.max(positiveNumber(gap.sampleWindowMs) ?? 0, defaults.sampleWindowMs),
        maxPersistenceMs: Math.max(positiveNumber(gap.maxPersistenceMs) ?? 0, defaults.maxPersistenceMs)
      }
    };
  }

  if (!isRecord(input.marketMaking)) return input;
  const legacy = input.marketMaking;
  const legacyCapital = positiveNumber(legacy.orderSizeToman);
  const legacyDepth = positiveNumber(legacy.minVisibleDepthToman);
  const legacySpread = nonNegativeNumber(legacy.maxGrossSpreadBps);
  const legacySafety = nonNegativeNumber(legacy.adverseSelectionBufferBps);
  return {
    ...input,
    gapTrading: {
      ...defaults,
      enabled: false,
      capitalToman: legacyCapital ? Math.min(defaults.capitalToman, legacyCapital) : defaults.capitalToman,
      minVisibleDepthToman: legacyDepth ? Math.max(defaults.minVisibleDepthToman, legacyDepth) : defaults.minVisibleDepthToman,
      maxSpreadBps: legacySpread === undefined ? defaults.maxSpreadBps : Math.min(defaults.maxSpreadBps, legacySpread),
      safetyBufferBps: legacySafety === undefined ? defaults.safetyBufferBps : Math.max(defaults.safetyBufferBps, legacySafety)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function saveBotSettings(input: unknown): Promise<BotSettings> {
  const settings = normalizeAiAutopilot(botSettingsSchema.parse(input));
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  applyBitgetRuntimeSettings(settings);
  return settings;
}

export function migrateStoredAiAgentSettings(input: unknown): unknown {
  if (input === undefined) return defaultAiAgentSettings;
  if (!isRecord(input)) return input;
  return {
    ...input,
    autopilotProfile: inferAiAutopilotProfile(input)
  };
}

function normalizeAiAutopilot(settings: BotSettings): BotSettings {
  return {
    ...settings,
    aiAgent: applyAiAutopilotProfile(settings.aiAgent)
  };
}
