import { describe, expect, test } from "bun:test";
import {
  AI_AUTOPILOT_PROFILES,
  applyAiAutopilotProfile,
  inferAiAutopilotProfile,
  recommendAiCapitalToman
} from "@/lib/ai-agent/autopilot-profiles";
import {
  evaluateAiCandidateProtections,
  evaluateAiGlobalProtections
} from "@/lib/ai-agent/protections";
import { defaultAiAgentSettings } from "@/lib/ai-agent/settings";
import { createDefaultAiAgentState } from "@/lib/ai-agent/store";
import { AI_FEATURE_NAMES, type AiDemoTrade, type AiFeatures } from "@/lib/ai-agent/types";
import { migrateStoredAiAgentSettings } from "@/lib/bot-settings-store";

const now = 1_900_000_000_000;

describe("AI Autopilot profiles", () => {
  test("migrates an existing tuned profile without changing capital controls", () => {
    const legacy = {
      ...defaultAiAgentSettings,
      autopilotProfile: undefined,
      ...AI_AUTOPILOT_PROFILES.active.technical,
      demoCapitalToman: 12_000_000,
      maxLiveCapitalToman: 4_000_000
    };
    expect(inferAiAutopilotProfile(legacy)).toBe("active");
    expect(migrateStoredAiAgentSettings(legacy)).toMatchObject({
      autopilotProfile: "active",
      demoCapitalToman: 12_000_000,
      maxLiveCapitalToman: 4_000_000
    });
  });

  test("applies technical policy while preserving operator capital limits", () => {
    const settings = applyAiAutopilotProfile({
      ...defaultAiAgentSettings,
      autopilotProfile: "conservative" as const,
      demoCapitalToman: 20_000_000,
      maxLiveCapitalToman: 3_000_000
    });
    expect(settings.scannerMinConfidencePercent).toBe(
      AI_AUTOPILOT_PROFILES.conservative.technical.scannerMinConfidencePercent
    );
    expect(settings.demoCapitalToman).toBe(20_000_000);
    expect(settings.maxLiveCapitalToman).toBe(3_000_000);
  });

  test("sizes positions below the operator cap and increases only with model quality", () => {
    const low = recommendAiCapitalToman({
      maximumToman: 1_000_000,
      probability: 0.78,
      minimumConfidencePercent: 78,
      profile: "balanced"
    });
    const high = recommendAiCapitalToman({
      maximumToman: 1_000_000,
      probability: 0.95,
      minimumConfidencePercent: 78,
      profile: "balanced"
    });
    expect(low).toBe(350_000);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(750_000);
  });
});

describe("AI Autopilot protections", () => {
  test("pauses after a loss streak and automatically releases after the cooling period", () => {
    const settings = { ...defaultAiAgentSettings, autopilotProfile: "balanced" as const };
    const state = createDefaultAiAgentState(settings.demoCapitalToman, now - 60_000);
    state.demo.recentTrades = [
      trade("loss-3", "BTCUSDT", now - 1_000, -10_000),
      trade("loss-2", "ETHUSDT", now - 2_000, -8_000),
      trade("loss-1", "SOLUSDT", now - 3_000, -5_000)
    ];
    state.demo.realizedPnlToman = -23_000;

    const active = evaluateAiGlobalProtections(state, settings, now);
    expect(active.active).toBeTrue();
    expect(active.blockers).toContain("autopilot-loss-streak-pause");

    const released = evaluateAiGlobalProtections(
      state,
      settings,
      now + AI_AUTOPILOT_PROFILES.balanced.protection.globalPauseMs + 1
    );
    expect(released.active).toBeFalse();
  });

  test("locks a weak pair without stopping unrelated markets", () => {
    const settings = { ...defaultAiAgentSettings, autopilotProfile: "balanced" as const };
    const state = createDefaultAiAgentState(settings.demoCapitalToman, now - 60_000);
    state.demo.recentTrades = [
      trade("recovery", "ETHUSDT", now - 500, 2_000),
      trade("x-3", "XRPUSDT", now - 1_000, -3_000),
      trade("x-2", "XRPUSDT", now - 2_000, 500),
      trade("x-1", "XRPUSDT", now - 3_000, -1_000)
    ];
    state.demo.realizedPnlToman = -1_500;

    const xrp = evaluateAiCandidateProtections(state, settings, "XRPUSDT", now);
    const btc = evaluateAiCandidateProtections(state, settings, "BTCUSDT", now);
    expect(xrp.blockers).toContain("autopilot-low-profit-pair");
    expect(btc.active).toBeFalse();
  });

  test("enforces pair cooldown after a completed Live execution", () => {
    const settings = { ...defaultAiAgentSettings, autopilotProfile: "active" as const };
    const state = createDefaultAiAgentState(settings.demoCapitalToman, now - 60_000);
    state.decisions.push({
      id: "live:btc",
      at: now - 1_000,
      mode: "live",
      action: "executed",
      kind: "autonomous-market",
      symbol: "BTCUSDT"
    });
    expect(evaluateAiCandidateProtections(state, settings, "BTCUSDT", now).blockers)
      .toContain("autopilot-pair-cooldown");
    expect(evaluateAiCandidateProtections(state, settings, "ETHUSDT", now).active).toBeFalse();
  });
});

function trade(id: string, symbol: string, closedAt: number, pnlToman: number): AiDemoTrade {
  return {
    id,
    kind: "autonomous-market",
    signalId: id,
    symbol,
    openedAt: closedAt - 5_000,
    closedAt,
    inputToman: 100_000,
    outputToman: 100_000 + pnlToman,
    pnlToman,
    pnlBps: pnlToman / 10,
    exitReason: pnlToman >= 0 ? "take-profit" : "stop-loss",
    predictionProbability: 0.75,
    features: zeroFeatures(),
    modelVersion: 1
  };
}

function zeroFeatures() {
  return Object.fromEntries(AI_FEATURE_NAMES.map(name => [name, 0])) as AiFeatures;
}
