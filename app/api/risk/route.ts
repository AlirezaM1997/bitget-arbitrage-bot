import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { getBotSettings } from "@/lib/bot-settings-store";
import { RISK_STRATEGIES } from "@/lib/risk/types";
import {
  STRATEGY_RUNTIME_CAPABILITIES,
  applyRuntimeCapabilityEvaluation,
  hasRuntimeReadyStrategy,
  type RuntimeEnvironmentKind
} from "@/lib/strategy-runtime-capabilities";
import {
  RiskControlError,
  armRiskControl,
  disarmRiskControl,
  emergencyStopRiskControl,
  getRiskControlSnapshot,
  resetRiskControl
} from "@/lib/risk/store";
import { getLiveOwnerStatus } from "@/lib/runtime/live-owner";
import { getLiveSchedulerStatus } from "@/lib/runtime/live-scheduler";

export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("arm") }).strict(),
  z.object({ action: z.literal("disarm") }).strict(),
  z.object({ action: z.literal("emergency-stop"), reason: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal("reset") }).strict()
]);

export async function GET() {
  try {
    return NextResponse.json(await dashboardRiskSnapshot());
  } catch (error) {
    return riskErrorResponse(error);
  }
}

export async function PATCH(_request?: Request) {
  return NextResponse.json({
    error: "کنترل موتورها و محدودیت‌های سراسری از داشبورد حذف و غیرفعال شده‌اند."
  }, { status: 410 });
}

export async function POST(request: Request) {
  if (!isDashboardRiskRequest(request)) return NextResponse.json({ error: "Risk actions are accepted only from this dashboard" }, { status: 403 });
  try {
    // Account mode and Bitget Demo API are dashboard settings. Load them
    // before acquiring or releasing the account-scoped Live owner.
    await getBotSettings();
    const input = actionSchema.parse(await request.json());
    if (input.action === "arm") {
      const environment = currentEnvironment();
      const snapshot = await getRiskControlSnapshot();
      if (!hasRuntimeReadyStrategy(snapshot.state, environment.kind)) {
        const evaluated = applyRuntimeCapabilityEvaluation(snapshot.evaluation, environment.kind);
        const enabled = RISK_STRATEGIES.filter(strategy => snapshot.state.strategies[strategy].enabled);
        const inspected = enabled.length ? enabled : [...RISK_STRATEGIES];
        const blockers = [...new Set(inspected.flatMap(strategy => evaluated.strategies[strategy].blockers))];
        throw new RiskControlError(
          "هیچ موتور فعالی در محیط فعلی آماده اجرای واقعی نیست",
          "RISK_BLOCKED",
          blockers
        );
      }
      await armRiskControl();
    }
    if (input.action === "disarm") await disarmRiskControl();
    if (input.action === "emergency-stop") await emergencyStopRiskControl(input.reason);
    if (input.action === "reset") await resetRiskControl();
    return NextResponse.json(await dashboardRiskSnapshot());
  } catch (error) {
    return riskErrorResponse(error);
  }
}

async function dashboardRiskSnapshot() {
  const settings = await getBotSettings();
  const environment = currentEnvironment();
  const snapshot = await getRiskControlSnapshot();
  const liveOwner = await getLiveOwnerStatus();
  const runtimeEvaluation = applyRuntimeCapabilityEvaluation(snapshot.evaluation, environment.kind);
  const evaluation = snapshot.state.masterArmed && !liveOwner.heldByThisProcess
    ? appendGlobalBlocker(
        runtimeEvaluation,
        liveOwner.locked ? "live-owner-held-by-another-runtime" : "live-owner-not-held"
      )
    : runtimeEvaluation;
  return {
    ...snapshot,
    evaluation,
    environment: {
      apiBase: config.BITGET_API_BASE,
      kind: environment.kind,
      demo: settings.bitgetDemoTrading,
      accountMode: settings.bitgetAccountMode,
      credentialsConfigured: Boolean(
        config.BITGET_API_KEY
        && config.BITGET_API_SECRET
        && config.BITGET_API_PASSPHRASE
      )
    },
    liveOwner,
    liveScheduler: getLiveSchedulerStatus(),
    runtimeCapabilities: STRATEGY_RUNTIME_CAPABILITIES
  };
}

function appendGlobalBlocker(evaluation: Awaited<ReturnType<typeof getRiskControlSnapshot>>["evaluation"], blocker: string) {
  const strategies = Object.fromEntries(RISK_STRATEGIES.map(strategy => {
    const current = evaluation.strategies[strategy];
    return [strategy, { ...current, canExecute: false, blockers: [...new Set([...current.blockers, blocker])] }];
  })) as typeof evaluation.strategies;
  return {
    ...evaluation,
    canExecute: false,
    globalBlockers: [...new Set([...evaluation.globalBlockers, blocker])],
    strategies
  };
}

function currentEnvironment(): { hostname: string; kind: RuntimeEnvironmentKind } {
  const hostname = new URL(config.BITGET_API_BASE).hostname.toLowerCase();
  const kind: RuntimeEnvironmentKind = hostname === "api.bitget.com" ? "mainnet" : "custom";
  return { hostname, kind };
}

export function isDashboardRiskRequest(request: Request) {
  if (request.headers.get("x-risk-action") !== "bitget-dashboard") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function riskErrorResponse(error: unknown) {
  if (error instanceof RiskControlError) {
    return NextResponse.json({ error: error.message, code: error.code, blockers: error.blockers }, { status: error.code === "RISK_BLOCKED" ? 409 : 400 });
  }
  if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid risk-control request", issues: error.issues }, { status: 400 });
  return NextResponse.json({ error: error instanceof Error ? error.message : "Risk-control operation failed" }, { status: 500 });
}
