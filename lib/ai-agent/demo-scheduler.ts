import { randomUUID } from "node:crypto";
import type { BotSettings } from "@/lib/bot-settings";
import { getBotSettings } from "@/lib/bot-settings-store";
import { bitgetClientSettings } from "@/lib/bitget-runtime-settings";
import { BitgetClient } from "@/lib/exchanges/bitget";
import { runAiDemoCycle } from "./demo";
import { scanAiMarketBooks } from "./scanner-service";

const MIN_INTERVAL_MS = 1_000;
const FALLBACK_INTERVAL_MS = 5_000;
const MAX_EVENTS = 30;

export type AiDemoSchedulerEvent = {
  at: number;
  outcome: "disabled" | "demo-updated" | "in-flight" | "build-worker" | "error";
  detail?: string;
};

type Runtime = {
  generation: string;
  running: boolean;
  inFlight: boolean;
  timer?: ReturnType<typeof setTimeout>;
  intervalMs: number;
  lastTickAt: number | null;
  lastCompletedAt: number | null;
  nextTickAt: number | null;
  events: AiDemoSchedulerEvent[];
};

type Dependencies = {
  isRuntime(): boolean;
  now(): number;
  getSettings(): Promise<BotSettings>;
  runCycle(settings: BotSettings): Promise<{ detail: string }>;
};

type SchedulerGlobal = typeof globalThis & { __bitgetAiDemoScheduler?: Runtime };

const defaults: Dependencies = {
  isRuntime: () => process.env.NEXT_PHASE !== "phase-production-build",
  now: () => Date.now(),
  getSettings: getBotSettings,
  runCycle: async settings => {
    const client = new BitgetClient(bitgetClientSettings(settings));
    const books = await client.getAllOrderBooks();
    const candidates = scanAiMarketBooks(books, settings, {
      capitalToman: settings.aiAgent.demoTradeCapitalToman
    }).candidates;
    return runAiDemoCycle({ books, candidates, settings });
  }
};

export function ensureAiDemoSchedulerStarted(dependencies: Dependencies = defaults) {
  const root = globalThis as SchedulerGlobal;
  const current = root.__bitgetAiDemoScheduler;
  if (current?.running) return getAiDemoSchedulerStatus(current);
  const runtime = current ?? createRuntime();
  root.__bitgetAiDemoScheduler = runtime;
  if (!dependencies.isRuntime()) {
    push(runtime, { at: dependencies.now(), outcome: "build-worker" });
    return getAiDemoSchedulerStatus(runtime);
  }
  runtime.running = true;
  runtime.generation = randomUUID();
  void initialize(runtime, dependencies, runtime.generation);
  return getAiDemoSchedulerStatus(runtime);
}

export function stopAiDemoScheduler() {
  const runtime = (globalThis as SchedulerGlobal).__bitgetAiDemoScheduler;
  if (!runtime) return;
  runtime.running = false;
  runtime.generation = randomUUID();
  runtime.nextTickAt = null;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
}

export async function runAiDemoSchedulerTick(runtime: Runtime, dependencies: Dependencies = defaults) {
  const now = dependencies.now();
  if (runtime.inFlight) return push(runtime, { at: now, outcome: "in-flight" });
  runtime.inFlight = true;
  runtime.lastTickAt = now;
  try {
    const settings = await dependencies.getSettings();
    runtime.intervalMs = normalizeInterval(settings.scanIntervalMs);
    if (!settings.aiAgent.enabled) return push(runtime, { at: now, outcome: "disabled" });
    // Freeze the locally validated online model during Live execution. Learning
    // resumes when the operator explicitly returns the assistant to Demo.
    if (settings.aiAgent.mode !== "demo") {
      return push(runtime, { at: now, outcome: "disabled", detail: "live-mode-model-frozen" });
    }
    const result = await dependencies.runCycle(settings);
    return push(runtime, { at: now, outcome: "demo-updated", detail: result.detail });
  } catch (error) {
    return push(runtime, {
      at: now,
      outcome: "error",
      detail: safeDetail(error instanceof Error ? error.message : "demo-cycle-failed")
    });
  } finally {
    runtime.inFlight = false;
    runtime.lastCompletedAt = dependencies.now();
  }
}

export function getAiDemoSchedulerStatus(runtime = (globalThis as SchedulerGlobal).__bitgetAiDemoScheduler) {
  return {
    running: runtime?.running ?? false,
    inFlight: runtime?.inFlight ?? false,
    intervalMs: runtime?.intervalMs ?? MIN_INTERVAL_MS,
    lastTickAt: runtime?.lastTickAt ?? null,
    lastCompletedAt: runtime?.lastCompletedAt ?? null,
    nextTickAt: runtime?.nextTickAt ?? null,
    lastOutcome: runtime?.events.at(-1)?.outcome ?? null,
    lastError: [...(runtime?.events ?? [])].reverse().find(event => event.outcome === "error")?.detail ?? null,
    events: runtime ? [...runtime.events] : []
  };
}

function createRuntime(): Runtime {
  return {
    generation: randomUUID(),
    running: false,
    inFlight: false,
    intervalMs: MIN_INTERVAL_MS,
    lastTickAt: null,
    lastCompletedAt: null,
    nextTickAt: null,
    events: []
  };
}

async function initialize(runtime: Runtime, dependencies: Dependencies, generation: string) {
  try {
    const settings = await dependencies.getSettings();
    runtime.intervalMs = normalizeInterval(settings.scanIntervalMs);
  } catch {
    runtime.intervalMs = FALLBACK_INTERVAL_MS;
  }
  schedule(runtime, dependencies, generation);
}

function schedule(runtime: Runtime, dependencies: Dependencies, generation: string) {
  if (!runtime.running || runtime.generation !== generation) return;
  const delay = normalizeInterval(runtime.intervalMs);
  runtime.nextTickAt = dependencies.now() + delay;
  runtime.timer = setTimeout(async () => {
    if (!runtime.running || runtime.generation !== generation) return;
    await runAiDemoSchedulerTick(runtime, dependencies);
    schedule(runtime, dependencies, generation);
  }, delay);
  runtime.timer.unref?.();
}

function normalizeInterval(value: number) {
  return Number.isFinite(value) ? Math.max(MIN_INTERVAL_MS, Math.floor(value)) : FALLBACK_INTERVAL_MS;
}

function push(runtime: Runtime, event: AiDemoSchedulerEvent) {
  runtime.events.push(event);
  if (runtime.events.length > MAX_EVENTS) runtime.events.splice(0, runtime.events.length - MAX_EVENTS);
  return event;
}

function safeDetail(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}
