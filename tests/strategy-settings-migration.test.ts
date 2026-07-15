import { describe, expect, test } from "bun:test";
import { migrateStoredStrategyLabSettings } from "@/lib/bot-settings-store";
import { strategyLabSettingsSchema } from "@/lib/strategy-settings";

describe("strategy settings migration", () => {
  test("replaces legacy Market Making settings without enabling Gap Trading", () => {
    const migrated = migrateStoredStrategyLabSettings({
      enabled: true,
      marketMaking: {
        enabled: true,
        orderSizeToman: 900_000,
        minVisibleDepthToman: 3_000_000,
        maxGrossSpreadBps: 250,
        adverseSelectionBufferBps: 45
      }
    });
    const parsed = strategyLabSettingsSchema.parse(migrated);
    expect(parsed.gapTrading.enabled).toBe(false);
    expect(parsed.gapTrading.capitalToman).toBe(250_000);
    expect(parsed.gapTrading.minVisibleDepthToman).toBe(3_000_000);
    expect(parsed.gapTrading.maxSpreadBps).toBe(80);
    expect(parsed.gapTrading.safetyBufferBps).toBe(45);
  });

  test("upgrades an old Gap Trading window while preserving explicit values", () => {
    const migrated = migrateStoredStrategyLabSettings({
      gapTrading: { enabled: true, capitalToman: 123_000, sampleWindowMs: 20_000, maxPersistenceMs: 15_000 }
    });
    const parsed = strategyLabSettingsSchema.parse(migrated);
    expect(parsed.gapTrading.enabled).toBe(true);
    expect(parsed.gapTrading.capitalToman).toBe(123_000);
    expect(parsed.gapTrading.sampleWindowMs).toBe(60_000);
    expect(parsed.gapTrading.maxPersistenceMs).toBe(45_000);
    expect(parsed.gapTrading.minOutcomeSamples).toBe(20);
  });

  test("does not overwrite a calibrated Gap Trading configuration", () => {
    const source = {
      gapTrading: { ...strategyLabSettingsSchema.parse({}).gapTrading, enabled: true, capitalToman: 123_000 },
      marketMaking: { enabled: true }
    };
    expect(migrateStoredStrategyLabSettings(source)).toBe(source);
  });
});
