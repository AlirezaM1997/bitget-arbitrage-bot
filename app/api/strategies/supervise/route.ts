import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { listStrategyExecutions } from "@/lib/strategy-execution-store";
import {
  handleSpotPositionRecoveryRequest,
  isDashboardStrategyRequest,
  type SpotPositionRouteKind
} from "@/lib/strategies/spot-position-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SupervisorDependencies = {
  isMainnet(): boolean;
  listExecutions: typeof listStrategyExecutions;
  recoverSpot(request: Request, kind: SpotPositionRouteKind): Promise<Response>;
};

type SupervisorRuntime = {
  timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
  lastTickAt: number | null;
};

type SupervisorGlobal = typeof globalThis & { __bitgetStrategySupervisor?: SupervisorRuntime };

const defaultDependencies: SupervisorDependencies = {
  isMainnet: () => {
    try { return new URL(config.BITGET_API_BASE).hostname.toLowerCase() === "api.bitget.com"; }
    catch { return false; }
  },
  listExecutions: listStrategyExecutions,
  recoverSpot: (request, kind) => handleSpotPositionRecoveryRequest(request, kind)
};

export async function POST(request: Request) {
  void request;
  return NextResponse.json({
    error: "Supervisor استراتژی‌های قدیمی در نسخه Bitget غیرفعال است.",
    code: "ENGINE_UNAVAILABLE"
  }, { status: 410 });
}

/** Starts the risk-reducing monitor inside the long-running Node process. */
export function ensureStrategySupervisorStarted(intervalMs = 5_000) {
  // `next build` also uses NODE_ENV=production. A build worker must never
  // reconcile positions or mutate runtime state, even though order adapters
  // have their own lower-level owner fence.
  if (!shouldStartStrategySupervisor()) return;
  const root = globalThis as SupervisorGlobal;
  if (root.__bitgetStrategySupervisor) return;
  const runtime = { inFlight: false, lastTickAt: null } as SupervisorRuntime;
  const tick = async () => {
    if (runtime.inFlight) return;
    runtime.inFlight = true;
    try {
      await POST(new Request("http://bitget-internal/api/strategies/supervise", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "bitget-internal",
          origin: "http://bitget-internal",
          "x-strategy-action": "bitget-dashboard"
        },
        body: "{}"
      }));
      runtime.lastTickAt = Date.now();
    } catch {
      // Child recovery/monitor routes persist audit failures and trigger their
      // own Emergency Stop. A later tick retries non-terminal work.
    } finally {
      runtime.inFlight = false;
    }
  };
  runtime.timer = setInterval(() => void tick(), Math.max(1_000, intervalMs));
  runtime.timer.unref?.();
  root.__bitgetStrategySupervisor = runtime;
  void tick();
}

export function shouldStartStrategySupervisor(environment: NodeJS.ProcessEnv = process.env) {
  return environment.NODE_ENV === "production"
    && environment.NEXT_PHASE !== "phase-production-build"
    && environment.NEXT_RUNTIME === "nodejs";
}

/**
 * Supervises durable non-Triangle positions. It can close/recover exposure while
 * Master Live is disarmed, but it never creates a new position.
 */
export async function handleStrategySupervisor(request: Request, dependencies: SupervisorDependencies) {
  if (!isDashboardStrategyRequest(request)) {
    return NextResponse.json({ error: "Position supervision is accepted only from this dashboard" }, { status: 403 });
  }
  try {
    z.object({}).strict().parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: "Supervisor body must be an empty JSON object" }, { status: error instanceof z.ZodError ? 400 : 400 });
  }
  if (!dependencies.isMainnet()) {
    return NextResponse.json({ status: "inactive", reason: "mainnet-required" });
  }

  const delegated = (body: unknown) => {
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    return new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) });
  };

  const history = await dependencies.listExecutions({ limit: 200 });
  const activeStates = new Set(["SUBMITTING", "PARTIALLY_FILLED", "HEDGING", "RECOVERING"]);
  const activeSpot = history.records
    .filter(record => (record.strategy === "gapTrading" || record.strategy === "imbalance" || record.strategy === "aiAgent")
      && Boolean(record.signalId)
      && activeStates.has(record.state))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  // Probe the oldest active record directly. Its per-record generation lock is
  // the authoritative fence: a healthy worker returns POSITION_ALREADY_OWNED,
  // while a restarted process can safely take over its dead generation.
  if (!activeSpot.length) {
    return NextResponse.json({ status: "checked", spotRecoveries: [], activeSpotCount: 0 });
  }

  const spotRecoveries: Array<Record<string, unknown>> = [];
  for (const record of activeSpot.slice(0, 10)) {
    if (!record.signalId) continue;
    const kind: SpotPositionRouteKind = record.strategy === "gapTrading"
        ? "orderbook-gap"
      : record.strategy === "aiAgent"
        ? "ai-autonomous"
        : "orderbook-imbalance";
    const response = await dependencies.recoverSpot(delegated({ signalId: record.signalId }), kind);
    spotRecoveries.push({ executionId: record.id, kind, ...await responsePayload(response) });
  }
  const recovered = spotRecoveries.some(item => item.status === "recovered" || item.status === "already-flat");
  const failed = spotRecoveries.some(item => Number(item.httpStatus) >= 500);
  return NextResponse.json({
    status: recovered ? "recovery-checked" : "recovery-deferred",
    spotRecoveries,
    activeSpotCount: activeSpot.length
  }, { status: failed ? 502 : 200 });
}

async function responsePayload(response: Response) {
  try { return { httpStatus: response.status, ...await response.json() as Record<string, unknown> }; }
  catch { return { httpStatus: response.status, error: "Supervisor child response was not JSON" }; }
}
