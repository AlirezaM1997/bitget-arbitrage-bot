import { NextResponse } from "next/server";
import { getBotSettings } from "@/lib/bot-settings-store";
import { getRiskControlSnapshot } from "@/lib/risk/store";
import { getLiveOwnerStatus } from "@/lib/runtime/live-owner";
import { getAiDemoSchedulerStatus } from "@/lib/ai-agent/demo-scheduler";
import { aiModelReadinessBlockers } from "@/lib/ai-agent/live-policy";
import { getAiMarketScannerStatus } from "@/lib/ai-agent/scanner-service";
import { listOfflineModelArtifactIds } from "@/lib/ai-agent/offline";
import { readAiAgentState, resetAiAgentState } from "@/lib/ai-agent/store";
import { evaluateAiGlobalProtections } from "@/lib/ai-agent/protections";
import { AI_AUTOPILOT_PROFILES } from "@/lib/ai-agent/autopilot-profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await buildSnapshot());
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isDashboardReset(request)) {
    return NextResponse.json({ error: "بازنشانی فقط از همین داشبورد پذیرفته می‌شود" }, { status: 403 });
  }
  try {
    const settings = await getBotSettings();
    if (settings.aiAgent.enabled && settings.aiAgent.mode === "live") {
      return NextResponse.json({ error: "برای بازنشانی، ابتدا دستیار را از حالت Live خارج کنید" }, { status: 409 });
    }
    await resetAiAgentState(settings.aiAgent.demoCapitalToman);
    return NextResponse.json(await buildSnapshot());
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

async function buildSnapshot() {
  const settings = await getBotSettings();
  const now = Date.now();
  const [state, risk, owner, artifactIds] = await Promise.all([
    readAiAgentState(settings.aiAgent.demoCapitalToman),
    getRiskControlSnapshot(),
    getLiveOwnerStatus(),
    listOfflineModelArtifactIds()
  ]);
  const protection = evaluateAiGlobalProtections(state, settings.aiAgent, now);
  const baseBlockers = aiModelReadinessBlockers(state, settings.aiAgent, now);
  const blockers = [...baseBlockers];
  if (!risk.state.masterArmed) blockers.push("master-disarmed");
  if (risk.state.emergencyStop.active) blockers.push("emergency-stop-active");
  const aiRisk = risk.evaluation.strategies.aiAgent;
  if (!aiRisk?.canExecute) blockers.push(...(aiRisk?.blockers ?? ["ai-risk-engine-not-ready"]));
  if (risk.state.masterArmed && !owner.heldByThisProcess) {
    blockers.push(owner.locked ? "live-owner-held-by-another-runtime" : "live-owner-not-held");
  }

  const equityToman = state.demo.cashToman
    + state.demo.openPositions.reduce(
      (sum, position) => sum + (position.learningOnly ? 0 : position.lastMarkedOutputToman),
      0
    );
  const unrealizedPnlToman = state.demo.openPositions.reduce(
    (sum, position) => sum + (position.learningOnly
      ? 0
      : position.lastMarkedOutputToman - position.inputToman),
    0
  );
  const portfolioTrades = state.demo.recentTrades.filter(trade => !trade.learningOnly);
  const wins = portfolioTrades.filter(trade => trade.pnlToman > 0).length;
  const accuracy = state.model.trainingSamples > 0
    ? state.model.correctPredictions / state.model.trainingSamples * 100
    : null;
  const modelOnlyBlockers = baseBlockers.filter(blocker => blocker !== "agent-disabled" && blocker !== "demo-mode");

  return {
    fetchedAt: now,
    runtime: getAiDemoSchedulerStatus(),
    scanner: getAiMarketScannerStatus(),
    offline: {
      role: "candidate-shadow-only" as const,
      artifactCount: artifactIds.length,
      artifactIds: artifactIds.slice(-50).reverse(),
      contributesToLiveReadiness: false
    },
    autopilot: {
      profile: settings.aiAgent.autopilotProfile,
      profileLabel: AI_AUTOPILOT_PROFILES[settings.aiAgent.autopilotProfile].label,
      protection: {
        active: protection.active,
        scope: protection.scope,
        blockers: protection.blockers,
        until: protection.until
      }
    },
    model: {
      version: `online-logistic-v${state.model.modelVersion}`,
      trainingSamples: state.model.trainingSamples,
      predictionAccuracyPercent: accuracy,
      brierScore: state.model.trainingSamples > 0
        ? state.model.brierScoreSum / state.model.trainingSamples
        : null,
      probabilityPercent: state.decisions.at(-1)?.probability !== undefined
        ? state.decisions.at(-1)!.probability! * 100
        : null,
      readyForLive: modelOnlyBlockers.length === 0,
      blockers: modelOnlyBlockers,
      weights: state.model.weights
    },
    demo: {
      initialCapitalToman: state.demo.initialCapitalToman,
      cashToman: state.demo.cashToman,
      equityToman,
      realizedPnlToman: state.demo.realizedPnlToman,
      unrealizedPnlToman,
      returnPercent: state.demo.initialCapitalToman > 0
        ? (equityToman - state.demo.initialCapitalToman) / state.demo.initialCapitalToman * 100
        : 0,
      tradeCount: portfolioTrades.length,
      learningSampleCount: state.model.trainingSamples,
      winCount: wins,
      winRatePercent: portfolioTrades.length > 0 ? wins / portfolioTrades.length * 100 : 0,
      maxDrawdownToman: state.demo.maxDrawdownToman,
      openPositions: state.demo.openPositions,
      recentTrades: state.demo.recentTrades
    },
    live: {
      requested: settings.aiAgent.enabled && settings.aiAgent.mode === "live",
      canExecute: blockers.length === 0,
      masterArmed: risk.state.masterArmed,
      blockers: [...new Set(blockers)],
      decisions: state.decisions
        .filter(decision => decision.mode === "live")
        .slice(-100)
        .reverse()
        .map(decision => ({
          id: decision.id,
          at: decision.at,
          mode: decision.mode,
          action: decision.action === "executed" ? "ارسال به اجرای امن" : decision.action,
          kind: decision.kind,
          symbol: decision.symbol,
          probability: decision.probability,
          detail: decision.detail
        }))
    }
  };
}

function isDashboardReset(request: Request) {
  if (request.headers.get("x-ai-agent-action") !== "reset-demo-learning") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "AI agent operation failed";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

export type AiAgentApiSnapshot = Awaited<ReturnType<typeof buildSnapshot>>;
