import { describe, expect, test } from "bun:test";
import { defaultBotSettings } from "@/lib/bot-settings";
import { bitgetConnectionSettingsChanged } from "@/app/api/settings/route";

describe("dashboard Bitget connection settings", () => {
  test("detects only account-mode and exchange Demo API changes", () => {
    const unrelatedChange = {
      ...defaultBotSettings,
      maxTradeToman: defaultBotSettings.maxTradeToman + 1
    };
    expect(bitgetConnectionSettingsChanged(defaultBotSettings, unrelatedChange)).toBe(false);
    expect(bitgetConnectionSettingsChanged(defaultBotSettings, {
      ...defaultBotSettings,
      bitgetAccountMode: "classic"
    })).toBe(true);
    expect(bitgetConnectionSettingsChanged(defaultBotSettings, {
      ...defaultBotSettings,
      bitgetDemoTrading: true
    })).toBe(true);
  });
});
