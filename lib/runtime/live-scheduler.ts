import { randomUUID } from "node:crypto";
import { getBotSettings } from "@/lib/bot-settings-store";
import { getRiskControlSnapshot } from "@/lib/risk/store";
import {
  assertLiveOwnerForOrder,
  getLiveOwnerStatus,
  type PublicLiveOwnerStatus
} from "@/lib/runtime/live-owner";

const MIN_INTERVAL_MS = 1_000;
const FALLBACK_INTERVAL_MS = 5_000;
const MAX_EVENT_COUNT = 20;

export type LiveSchedulerOutcome =
  | "not-production"
  | "master-disarmed"
  | "triangle-disabled"
  // Retained as a status compatibility value for persisted/dashboard events;
  // this Triangle-only runtime never emits it.
  | "engines-disabled"
  | "risk-blocked"
  | "owner-not-held"
  | "in-flight"
  | "no-opportunity"
  | "busy"
  | "rejected"
  | "executed"
  | "error";

export type LiveSchedulerEvent = {
  at: number;
  outcome: LiveSchedulerOutcome;
  httpStatus?: number;
  code?: string;
  detail?: string;
  strategy?: "triangle";
};

export type LiveSchedulerStatus = {
  running: boolean;
  productionOnly: true;
  inFlight: boolean;
  startedAt: number | null;
  lastTickAt: number | null;
  lastCompletedAt: number | null;
  nextTickAt: number | null;
  intervalMs: number;
  tickCount: number;
  lastOutcome: LiveSchedulerOutcome | null;
  events: LiveSchedulerEvent[];
};

export type LiveSchedulerRuntime = {
  generation: string;
  running: boolean;
  inFlightToken: string | null;
  timer?: ReturnType<typeof setTimeout>;
  startedAt: number | null;
  lastTickAt: number | null;
  lastCompletedAt: number | null;
  nextTickAt: number | null;
  intervalMs: number;
  tickCount: number;
  events: LiveSchedulerEvent[];
};

export type LiveSchedulerDependencies = {
  isProduction(): boolean;
  now(): number;
  getSettings(): Promise<{ scanIntervalMs: number }>;
  getRiskSnapshot(): ReturnType<typeof getRiskControlSnapshot>;
  getOwnerStatus(): Promise<PublicLiveOwnerStatus>;
  assertOwner(): Promise<unknown>;
  executeTriangle(request: Request): Promise<Response>;
};

type SchedulerGlobal = typeof globalThis & {
  __bitgetLiveScheduler?: LiveSchedulerRuntime;
};

const defaultDependencies: LiveSchedulerDependencies = {
  // `next build` also sets NODE_ENV=production. Instrumentation must never
  // schedule entries in the build worker even if an old state file was armed.
  isProduction: () => process.env.NODE_ENV === "production"
    && process.env.NEXT_PHASE !== "phase-production-build",
  now: () => Date.now(),
  getSettings: getBotSettings,
  getRiskSnapshot: getRiskControlSnapshot,
  getOwnerStatus: getLiveOwnerStatus,
  assertOwner: assertLiveOwnerForOrder,
  executeTriangle: async request => {
    // Calling the route handler directly preserves the route's authoritative
    // risk lease, fresh scan, orderbook revalidation and recovery hooks without
    // depending on a browser tab or a public HTTP round trip.
    const { POST } = await import("@/app/api/live/execute/route");
    return POST(request);
  }
};

export function createLiveSchedulerRuntime(now = Date.now()): LiveSchedulerRuntime {
  return {
    generation: randomUUID(),
    running: false,
    inFlightToken: null,
    startedAt: now,
    lastTickAt: null,
    lastCompletedAt: null,
    nextTickAt: null,
    intervalMs: MIN_INTERVAL_MS,
    tickCount: 0,
    events: []
  };
}

/**
 * Starts one production-only scheduler per Node process. The account-scoped
 * Live Owner remains the cross-process fence, so only its holder may delegate
 * a route that can place orders.
 */
export function ensureLiveSchedulerStarted(dependencies: LiveSchedulerDependencies = defaultDependencies) {
  const root = globalThis as SchedulerGlobal;
  const existing = root.__bitgetLiveScheduler;
  if (existing?.running) return getLiveSchedulerStatus(existing);

  const runtime = existing ?? createLiveSchedulerRuntime(dependencies.now());
  root.__bitgetLiveScheduler = runtime;
  if (!dependencies.isProduction()) {
    runtime.running = false;
    pushEvent(runtime, { at: dependencies.now(), outcome: "not-production", code: "production-runtime-required" });
    return getLiveSchedulerStatus(runtime);
  }

  runtime.generation = randomUUID();
  runtime.running = true;
  runtime.startedAt = dependencies.now();
  void scheduleInitialTick(runtime, dependencies, runtime.generation);
  return getLiveSchedulerStatus(runtime);
}

export function stopLiveScheduler() {
  const runtime = (globalThis as SchedulerGlobal).__bitgetLiveScheduler;
  if (!runtime) return;
  runtime.running = false;
  runtime.generation = randomUUID();
  runtime.nextTickAt = null;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
}

/** One deterministic scheduler decision; exported so safety gates stay testable. */
export async function runLiveSchedulerTick(
  runtime: LiveSchedulerRuntime,
  dependencies: LiveSchedulerDependencies = defaultDependencies
): Promise<LiveSchedulerEvent> {
  const now = dependencies.now();
  if (runtime.inFlightToken) {
    return pushEvent(runtime, { at: now, outcome: "in-flight", code: "single-flight-fence" });
  }

  const fence = randomUUID();
  runtime.inFlightToken = fence;
  runtime.lastTickAt = now;
  runtime.tickCount += 1;
  try {
    // Settings are loaded on every tick. Besides keeping the interval dynamic,
    // this prevents a stale browser copy from becoming execution authority.
    const settings = await dependencies.getSettings();
    runtime.intervalMs = normalizeInterval(settings.scanIntervalMs);

    if (!dependencies.isProduction()) {
      return pushEvent(runtime, { at: now, outcome: "not-production", code: "production-runtime-required" });
    }

    const snapshot = await dependencies.getRiskSnapshot();
    if (!snapshot.state.masterArmed) {
      return pushEvent(runtime, { at: now, outcome: "master-disarmed" });
    }
    const triangle = snapshot.state.strategies.triangle;
    if (!triangle?.enabled) {
      return pushEvent(runtime, {
        at: now,
        outcome: "triangle-disabled",
        strategy: "triangle"
      });
    }
    const triangleEvaluation = snapshot.evaluation.strategies.triangle;
    if (!triangleEvaluation?.canExecute) {
      return pushEvent(runtime, {
        at: now,
        outcome: "risk-blocked",
        strategy: "triangle",
        code: safeCode(triangleEvaluation?.blockers[0])
      });
    }
    const owner = await dependencies.getOwnerStatus();
    if (!owner.heldByThisProcess) {
      return pushEvent(runtime, {
        at: now,
        outcome: "owner-not-held",
        code: owner.locked ? "live-owner-held-by-another-runtime" : "live-owner-not-held"
      });
    }
    // The status is informative; the token/record assertion is the actual fence.
    await dependencies.assertOwner();

    const response = await dependencies.executeTriangle(internalTriangleRequest());
    const payload = await safePayload(response);
    return pushEvent(runtime, {
      at: now,
      outcome: response.ok ? responseOutcome(payload.status) : "rejected",
      strategy: "triangle",
      httpStatus: response.status,
      code: safeCode(payload.code),
      detail: safeDetail(payload.reason ?? payload.error)
    });
  } catch (error) {
    return pushEvent(runtime, {
      at: now,
      outcome: "error",
      code: safeCode(errorCode(error)),
      detail: safeDetail(error instanceof Error ? error.message : "scheduler-tick-failed")
    });
  } finally {
    // A stopped/replaced generation cannot clear a newer tick's fence.
    if (runtime.inFlightToken === fence) runtime.inFlightToken = null;
    runtime.lastCompletedAt = dependencies.now();
  }
}

export function getLiveSchedulerStatus(runtime = (globalThis as SchedulerGlobal).__bitgetLiveScheduler): LiveSchedulerStatus {
  return {
    running: runtime?.running ?? false,
    productionOnly: true,
    inFlight: Boolean(runtime?.inFlightToken),
    startedAt: runtime?.startedAt ?? null,
    lastTickAt: runtime?.lastTickAt ?? null,
    lastCompletedAt: runtime?.lastCompletedAt ?? null,
    nextTickAt: runtime?.nextTickAt ?? null,
    intervalMs: runtime?.intervalMs ?? MIN_INTERVAL_MS,
    tickCount: runtime?.tickCount ?? 0,
    lastOutcome: runtime?.events.at(-1)?.outcome ?? null,
    events: runtime ? [...runtime.events] : []
  };
}

async function scheduleInitialTick(
  runtime: LiveSchedulerRuntime,
  dependencies: LiveSchedulerDependencies,
  generation: string
) {
  try {
    const settings = await dependencies.getSettings();
    runtime.intervalMs = normalizeInterval(settings.scanIntervalMs);
  } catch (error) {
    runtime.intervalMs = FALLBACK_INTERVAL_MS;
    pushEvent(runtime, {
      at: dependencies.now(),
      outcome: "error",
      code: "settings-read-failed",
      detail: safeDetail(error instanceof Error ? error.message : undefined)
    });
  }
  scheduleNextTick(runtime, dependencies, generation);
}

function scheduleNextTick(
  runtime: LiveSchedulerRuntime,
  dependencies: LiveSchedulerDependencies,
  generation: string
) {
  if (!runtime.running || runtime.generation !== generation) return;
  const delay = normalizeInterval(runtime.intervalMs);
  runtime.nextTickAt = dependencies.now() + delay;
  runtime.timer = setTimeout(async () => {
    if (!runtime.running || runtime.generation !== generation) return;
    await runLiveSchedulerTick(runtime, dependencies);
    if (!runtime.running || runtime.generation !== generation) return;
    scheduleNextTick(runtime, dependencies, generation);
  }, delay);
  runtime.timer.unref?.();
}

function internalTriangleRequest() {
  return new Request("http://bitget-internal/api/live/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "bitget-internal",
      origin: "http://bitget-internal",
      "x-live-action": "bitget-dashboard"
    },
    body: "{}"
  });
}

function normalizeInterval(value: number) {
  return Number.isFinite(value) ? Math.max(MIN_INTERVAL_MS, Math.floor(value)) : FALLBACK_INTERVAL_MS;
}

function responseOutcome(status: unknown): LiveSchedulerOutcome {
  if (["executed", "completed", "recovered", "opened"].includes(String(status))) return "executed";
  if (status === "no-opportunity") return "no-opportunity";
  if (status === "skipped" || status === "not-found") return "no-opportunity";
  if (status === "busy") return "busy";
  if (status === "rejected") return "rejected";
  return "no-opportunity";
}

async function safePayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown; blocker?: unknown }).code
    ?? (error as { blocker?: unknown }).blocker;
  return typeof value === "string" ? value : undefined;
}

function safeCode(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 120) || undefined;
}

function safeDetail(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{36,}={0,2}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240) || undefined;
}

function pushEvent(runtime: LiveSchedulerRuntime, event: LiveSchedulerEvent) {
  runtime.events.push(event);
  if (runtime.events.length > MAX_EVENT_COUNT) runtime.events.splice(0, runtime.events.length - MAX_EVENT_COUNT);
  return event;
}
