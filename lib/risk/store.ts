import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LiveOwnerError,
  acquireLiveOwner,
  assertLiveOwnerForOrder,
  releaseLiveOwner
} from "@/lib/runtime/live-owner";
import { strategyRuntimeBlocker, type RuntimeEnvironmentKind } from "@/lib/strategy-runtime-capabilities";
import {
  RISK_STRATEGIES,
  type ExecutionLease,
  type LeaseAcquisition,
  type PublicExecutionLease,
  type RiskControlSnapshot,
  type RiskEvaluation,
  type RiskState,
  type RiskStatePatch,
  type RiskStrategy,
  type StrategyReadiness
} from "./types";

const DEFAULT_TIME_ZONE = "Asia/Tehran";
const STATE_LOCK_TTL_MS = 10_000;
const STATE_LOCK_WAIT_MS = 2_000;
const MAX_LEASE_SLOTS = 10;
// These flags describe code that is present and covered by deterministic tests.
const IMPLEMENTED_READINESS: Record<RiskStrategy, Pick<StrategyReadiness,
  "positionStateReady" | "recoveryReady" | "executionAdapterReady"
>> = {
  triangle: { positionStateReady: true, recoveryReady: true, executionAdapterReady: true },
  gapTrading: { positionStateReady: false, recoveryReady: false, executionAdapterReady: false },
  imbalance: { positionStateReady: false, recoveryReady: false, executionAdapterReady: false },
  aiAgent: { positionStateReady: false, recoveryReady: false, executionAdapterReady: false }
};

const readinessSchema = z.object({
  positionStateReady: z.boolean(),
  recoveryReady: z.boolean(),
  executionAdapterReady: z.boolean()
});

const strategyStateSchema = z.object({
  enabled: z.boolean(),
  readiness: readinessSchema
});

const riskStateSchema = z.object({
  version: z.literal(1),
  masterArmed: z.boolean(),
  emergencyStop: z.object({
    active: z.boolean(),
    reason: z.string().nullable(),
    triggeredAt: z.string().datetime().nullable()
  }),
  daily: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    realizedPnlToman: z.number().finite(),
    lossToman: z.number().finite().nonnegative(),
    tradeCount: z.number().int().nonnegative(),
    consecutiveLosses: z.number().int().nonnegative()
  }),
  recordedPnlKeys: z.array(z.string().trim().min(1).max(200)).max(10_000).default([]),
  limits: z.object({
    maxDailyLossToman: z.number().finite().positive().max(1_000_000_000_000_000),
    // Triangle capital is sized from a point-in-time Spot USDT balance. Until
    // aggregate capital reservations exist, concurrent cycles could each size
    // from the same funds and exceed the configured exposure. Keep single-flight.
    maxConcurrentPositions: z.number().int().min(1).max(1),
    maxConsecutiveLosses: z.number().int().min(1).max(100).default(1)
  }),
  strategies: z.object(Object.fromEntries(RISK_STRATEGIES.map(strategy => [strategy, strategyStateSchema])) as Record<RiskStrategy, typeof strategyStateSchema>),
  updatedAt: z.string().datetime()
});

const leaseSchema = z.object({
  version: z.literal(1),
  slot: z.number().int().min(0).max(MAX_LEASE_SLOTS - 1),
  strategy: z.enum(RISK_STRATEGIES),
  purpose: z.enum(["execution", "recovery"]).default("execution"),
  owner: z.string().trim().min(1).max(200),
  token: z.string().uuid(),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});

export class RiskControlError extends Error {
  constructor(message: string, readonly code: "RISK_BLOCKED" | "INVALID_STATE" = "RISK_BLOCKED", readonly blockers: string[] = []) {
    super(message);
    this.name = "RiskControlError";
  }
}

function asRiskControlError(error: unknown) {
  if (error instanceof RiskControlError) return error;
  if (error instanceof LiveOwnerError) {
    return new RiskControlError(error.message, "RISK_BLOCKED", [error.blocker]);
  }
  return error;
}

async function liveOwnerBlockers() {
  try {
    await assertLiveOwnerForOrder();
    return [] as string[];
  } catch (error) {
    if (error instanceof LiveOwnerError) return [error.blocker];
    throw error;
  }
}

function currentRuntimeEnvironment(): RuntimeEnvironmentKind {
  try {
    return new URL(process.env.BITGET_API_BASE || "https://api.bitget.com").hostname.toLowerCase() === "api.bitget.com"
      ? "mainnet"
      : "custom";
  } catch {
    return "custom";
  }
}

export function riskStatePath() {
  return process.env.RISK_STATE_PATH?.trim() || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "risk-state.json");
}

function executionLeasePrefix() {
  return process.env.RISK_EXECUTION_LEASE_PATH?.trim() || path.join(/*turbopackIgnore: true*/ path.dirname(riskStatePath()), "risk-execution");
}

function leasePath(slot: number) {
  return `${executionLeasePrefix()}.${slot}.lock`;
}

function iso(now: Date | number = new Date()) {
  return new Date(now).toISOString();
}

export function riskDay(now: Date | number = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.RISK_TIME_ZONE?.trim() || DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function emptyReadiness(): StrategyReadiness {
  return {
    positionStateReady: false,
    recoveryReady: false,
    executionAdapterReady: false
  };
}

export function defaultRiskState(now: Date | number = new Date()): RiskState {
  const strategies = Object.fromEntries(RISK_STRATEGIES.map(strategy => [strategy, {
    enabled: strategy === "triangle",
    readiness: { ...emptyReadiness(), ...IMPLEMENTED_READINESS[strategy] }
  }])) as RiskState["strategies"];
  return {
    version: 1,
    masterArmed: false,
    emergencyStop: { active: false, reason: null, triggeredAt: null },
    daily: {
      date: riskDay(now),
      realizedPnlToman: 0,
      lossToman: 0,
      tradeCount: 0,
      consecutiveLosses: 0
    },
    recordedPnlKeys: [],
    limits: { maxDailyLossToman: 25, maxConcurrentPositions: 1, maxConsecutiveLosses: 1 },
    strategies,
    updatedAt: iso(now)
  };
}

function rollRiskDay(state: RiskState, now: Date | number): RiskState {
  const date = riskDay(now);
  if (state.daily.date === date) return state;
  return {
    ...state,
    masterArmed: false,
    daily: { date, realizedPnlToman: 0, lossToman: 0, tradeCount: 0, consecutiveLosses: 0 },
    updatedAt: iso(now)
  };
}

async function persistState(state: RiskState) {
  const target = riskStatePath();
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readStoredState(now: Date | number): Promise<RiskState> {
  try {
    const raw = JSON.parse(await readFile(/*turbopackIgnore: true*/ riskStatePath(), "utf8")) as Record<string, unknown>;
    const rawStrategies = raw.strategies && typeof raw.strategies === "object" && !Array.isArray(raw.strategies)
      ? raw.strategies as Record<string, unknown>
      : undefined;
    // Rebuild the strategy map from the current allow-list on every read. This
    // drops engines removed by an upgrade and supplies a fail-closed state for
    // a newly introduced/missing engine. Without this normalization, an older
    // build and a newer risk-state file can disagree about required keys.
    const migrated = rawStrategies
      ? {
          ...raw,
          strategies: Object.fromEntries(RISK_STRATEGIES.map(strategy => [
            strategy,
            rawStrategies[strategy] ?? {
              enabled: false,
              readiness: { ...emptyReadiness(), ...IMPLEMENTED_READINESS[strategy] }
            }
          ]))
        }
      : raw;
    const parsed = riskStateSchema.safeParse(migrated);
    if (!parsed.success) throw new RiskControlError(`Invalid risk state: ${parsed.error.message}`, "INVALID_STATE");
    return applyImplementedReadiness(parsed.data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = defaultRiskState(now);
    await persistState(state);
    return state;
  }
}

function applyImplementedReadiness(state: RiskState): RiskState {
  let changed = false;
  const strategies = { ...state.strategies };
  for (const strategy of RISK_STRATEGIES) {
    const implemented = IMPLEMENTED_READINESS[strategy];
    const current = state.strategies[strategy];
    const readiness = { ...current.readiness };
    for (const [key, value] of Object.entries(implemented) as Array<[keyof typeof implemented, boolean]>) {
      if (readiness[key] !== value) {
        readiness[key] = value;
        changed = true;
      }
    }
    strategies[strategy] = { ...current, readiness };
  }
  return changed ? { ...state, strategies } : state;
}

export async function getRiskState(now: Date | number = new Date()): Promise<RiskState> {
  const stored = await readStoredState(now);
  const state = rollRiskDay(stored, now);
  if (stored.daily.date === state.daily.date) return state;

  // A day rollover is a state mutation too. Serialize it so a concurrent PnL
  // update cannot be overwritten by a GET request that happened at midnight.
  const mutex = await acquireStateMutex();
  try {
    const latest = await readStoredState(now);
    const rolled = rollRiskDay(latest, now);
    if (latest.daily.date !== rolled.daily.date) {
      await persistState(rolled);
      await releaseLiveOwnerIfIdle(now);
    }
    return rolled;
  } finally {
    await releaseStateMutex(mutex);
  }
}

interface MutexRecord { token: string; expiresAt: string }

async function readMutex(lockPath: string): Promise<MutexRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(/*turbopackIgnore: true*/ lockPath, "utf8")) as MutexRecord;
    return typeof value.token === "string" && typeof value.expiresAt === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function tryRemoveStaleFile(lockPath: string, expectedToken: string | undefined, nowMs: number) {
  const current = await readMutex(lockPath);
  if (current) {
    if (current.token !== expectedToken || Date.parse(current.expiresAt) > nowMs) return false;
  } else {
    try {
      const info = await stat(/*turbopackIgnore: true*/ lockPath);
      if (info.mtimeMs + STATE_LOCK_TTL_MS > nowMs) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  await rm(lockPath, { force: true });
  return true;
}

async function acquireStateMutex(): Promise<{ token: string; lockPath: string }> {
  const lockPath = `${riskStatePath()}.mutation.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (Date.now() - startedAt <= STATE_LOCK_WAIT_MS) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, expiresAt: new Date(Date.now() + STATE_LOCK_TTL_MS).toISOString() }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { token, lockPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readMutex(lockPath);
      await tryRemoveStaleFile(lockPath, existing?.token, Date.now());
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new RiskControlError("Risk state is busy; retry shortly", "INVALID_STATE");
}

async function releaseStateMutex(mutex: { token: string; lockPath: string }) {
  const current = await readMutex(mutex.lockPath);
  if (current?.token === mutex.token) await rm(mutex.lockPath, { force: true });
}

async function mutateState(mutator: (state: RiskState) => RiskState | Promise<RiskState>, now: Date | number = new Date()) {
  const mutex = await acquireStateMutex();
  try {
    const current = rollRiskDay(await readStoredState(now), now);
    const updated = riskStateSchema.parse({ ...await mutator(current), updatedAt: iso(now) });
    await persistState(updated);
    return updated;
  } finally {
    await releaseStateMutex(mutex);
  }
}

function readinessBlockers(readiness: StrategyReadiness, strategy: RiskStrategy) {
  const blockers: string[] = [];
  if (!readiness.positionStateReady) blockers.push("position-state-not-ready");
  if (!readiness.recoveryReady) blockers.push("recovery-not-ready");
  if (!readiness.executionAdapterReady) blockers.push("execution-adapter-not-ready");
  return blockers;
}

export function evaluateRiskState(state: RiskState): RiskEvaluation {
  const dailyLossBreached = state.daily.lossToman >= state.limits.maxDailyLossToman
    || state.daily.realizedPnlToman <= -state.limits.maxDailyLossToman;
  const consecutiveLossBreached = state.daily.consecutiveLosses >= state.limits.maxConsecutiveLosses;
  const globalBlockers: string[] = [];
  if (!state.masterArmed) globalBlockers.push("master-not-armed");
  if (state.emergencyStop.active) globalBlockers.push("emergency-stop-active");
  if (dailyLossBreached) globalBlockers.push("daily-loss-limit-breached");
  if (consecutiveLossBreached) globalBlockers.push("consecutive-loss-limit-breached");

  const strategies = Object.fromEntries(RISK_STRATEGIES.map(strategy => {
    const config = state.strategies[strategy];
    const blockers = [...globalBlockers];
    if (!config.enabled) blockers.push("strategy-disabled");
    blockers.push(...readinessBlockers(config.readiness, strategy));
    const uniqueBlockers = [...new Set(blockers)];
    return [strategy, {
      enabled: config.enabled,
      ready: config.enabled && readinessBlockers(config.readiness, strategy).length === 0,
      canExecute: uniqueBlockers.length === 0,
      blockers: uniqueBlockers
    }];
  })) as RiskEvaluation["strategies"];

  return {
    canExecute: RISK_STRATEGIES.some(strategy => strategies[strategy].canExecute),
    dailyLossBreached,
    consecutiveLossBreached,
    globalBlockers,
    strategies
  };
}

export async function configureRiskState(patch: RiskStatePatch, now: Date | number = new Date()) {
  return mutateState(state => {
    const next: RiskState = {
      ...state,
      limits: {
        maxDailyLossToman: patch.limits?.maxDailyLossToman ?? state.limits.maxDailyLossToman,
        maxConcurrentPositions: patch.limits?.maxConcurrentPositions ?? state.limits.maxConcurrentPositions,
        maxConsecutiveLosses: patch.limits?.maxConsecutiveLosses ?? state.limits.maxConsecutiveLosses
      },
      strategies: { ...state.strategies }
    };
    for (const strategy of RISK_STRATEGIES) {
      const update = patch.strategies?.[strategy];
      if (!update) continue;
      next.strategies[strategy] = {
        enabled: update.enabled ?? state.strategies[strategy].enabled,
        readiness: { ...state.strategies[strategy].readiness, ...update.readiness }
      };
    }
    return next;
  }, now);
}

export async function armRiskControl(now: Date | number = new Date()) {
  let newlyAcquired = false;
  try {
    newlyAcquired = (await acquireLiveOwner()).newlyAcquired;
    return await mutateState(state => {
      const candidate = { ...state, masterArmed: true };
      const evaluation = evaluateRiskState(candidate);
      const hasReadyStrategy = RISK_STRATEGIES.some(strategy => evaluation.strategies[strategy].canExecute
        && !strategyRuntimeBlocker(strategy, currentRuntimeEnvironment()));
      if (!hasReadyStrategy) {
        const blockers = [...new Set(RISK_STRATEGIES.flatMap(strategy => evaluation.strategies[strategy].blockers))];
        throw new RiskControlError("هیچ موتور فعالی شرایط اجرای واقعی را ندارد", "RISK_BLOCKED", blockers);
      }
      return candidate;
    }, now);
  } catch (error) {
    if (newlyAcquired) await releaseLiveOwner().catch(() => undefined);
    throw asRiskControlError(error);
  }
}

export async function disarmRiskControl(now: Date | number = new Date()) {
  try {
    return await mutateState(state => ({ ...state, masterArmed: false }), now);
  } finally {
    // Disarm blocks new entries, but an in-flight cycle may still need the
    // owner token to flatten confirmed intermediate inventory.
    await releaseLiveOwnerIfIdle(now);
  }
}

export async function emergencyStopRiskControl(reason = "manual-emergency-stop", now: Date | number = new Date()) {
  const normalizedReason = reason.trim().slice(0, 500) || "manual-emergency-stop";
  try {
    return await mutateState(state => ({
      ...state,
      masterArmed: false,
      emergencyStop: { active: true, reason: normalizedReason, triggeredAt: iso(now) }
    }), now);
  } finally {
    await releaseLiveOwnerIfIdle(now);
  }
}

export async function resetRiskControl(now: Date | number = new Date()) {
  try {
    return await mutateState(state => ({
      ...state,
      masterArmed: false,
      emergencyStop: { active: false, reason: null, triggeredAt: null }
    }), now);
  } finally {
    await releaseLiveOwnerIfIdle(now);
  }
}

export async function recordRealizedPnl(
  pnlToman: number,
  now: Date | number = new Date(),
  idempotency?: string | { executionId?: string; idempotencyKey?: string }
) {
  if (!Number.isFinite(pnlToman)) throw new RiskControlError("PnL must be finite", "INVALID_STATE");
  const rawKey = typeof idempotency === "string"
    ? idempotency
    : idempotency?.idempotencyKey ?? idempotency?.executionId;
  const idempotencyKey = rawKey?.trim();
  if (rawKey !== undefined && (!idempotencyKey || idempotencyKey.length > 200)) {
    throw new RiskControlError("PnL idempotency key is invalid", "INVALID_STATE");
  }
  const updated = await mutateState(state => {
    if (idempotencyKey && state.recordedPnlKeys.includes(idempotencyKey)) return state;
    const daily = {
      ...state.daily,
      realizedPnlToman: state.daily.realizedPnlToman + pnlToman,
      lossToman: state.daily.lossToman + (pnlToman < 0 ? Math.abs(pnlToman) : 0),
      tradeCount: state.daily.tradeCount + 1,
      consecutiveLosses: pnlToman < 0 ? state.daily.consecutiveLosses + 1 : 0
    };
    const dailyLossBreached = daily.lossToman >= state.limits.maxDailyLossToman
      || daily.realizedPnlToman <= -state.limits.maxDailyLossToman;
    const consecutiveLossBreached = daily.consecutiveLosses >= state.limits.maxConsecutiveLosses;
    const breached = dailyLossBreached || consecutiveLossBreached;
    return {
      ...state,
      daily,
      recordedPnlKeys: idempotencyKey
        ? [...state.recordedPnlKeys.slice(-9_999), idempotencyKey]
        : state.recordedPnlKeys,
      masterArmed: breached ? false : state.masterArmed,
      emergencyStop: breached ? {
        active: true,
        reason: consecutiveLossBreached ? "consecutive-loss-limit-breached" : "daily-loss-limit-breached",
        triggeredAt: iso(now)
      } : state.emergencyStop
    };
  }, now);
  if (updated.emergencyStop.active) await releaseLiveOwnerIfIdle(now);
  return updated;
}

async function readLease(slot: number): Promise<ExecutionLease | undefined> {
  try {
    const parsed = leaseSchema.safeParse(JSON.parse(await readFile(/*turbopackIgnore: true*/ leasePath(slot), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function createLease(
  slot: number,
  strategy: RiskStrategy,
  purpose: "execution" | "recovery",
  owner: string,
  ttlMs: number,
  nowMs: number
): Promise<ExecutionLease | undefined> {
  const target = leasePath(slot);
  await mkdir(path.dirname(target), { recursive: true });
  const lease: ExecutionLease = {
    version: 1,
    slot,
    strategy,
    purpose,
    owner,
    token: randomUUID(),
    acquiredAt: iso(nowMs),
    expiresAt: iso(nowMs + ttlMs)
  };
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(lease), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return lease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readLease(slot);
    if (existing && Date.parse(existing.expiresAt) > nowMs) return undefined;
    await tryRemoveStaleFile(target, existing?.token, nowMs);
    try {
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(lease), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return lease;
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw retryError;
    }
  }
}

export async function acquireExecutionLease(input: {
  strategy: RiskStrategy;
  owner: string;
  ttlMs: number;
  now?: Date | number;
}): Promise<LeaseAcquisition> {
  const nowMs = new Date(input.now ?? new Date()).getTime();
  const owner = input.owner.trim();
  if (!RISK_STRATEGIES.includes(input.strategy) || !owner || owner.length > 200 || !Number.isInteger(input.ttlMs) || input.ttlMs < 100 || input.ttlMs > 300_000) {
    throw new RiskControlError("Invalid execution lease request", "INVALID_STATE");
  }
  const state = await getRiskState(nowMs);
  const strategyStatus = evaluateRiskState(state).strategies[input.strategy];
  if (!strategyStatus.canExecute) {
    if (strategyStatus.blockers.includes("master-not-armed") || strategyStatus.blockers.includes("emergency-stop-active")) {
      await releaseLiveOwnerIfIdle(nowMs);
    }
    return { acquired: false, reason: "risk-blocked", blockers: strategyStatus.blockers };
  }
  const runtimeBlocker = strategyRuntimeBlocker(input.strategy, currentRuntimeEnvironment());
  if (runtimeBlocker) return { acquired: false, reason: "risk-blocked", blockers: [runtimeBlocker] };
  const ownerBlockers = await liveOwnerBlockers();
  if (ownerBlockers.length) return { acquired: false, reason: "risk-blocked", blockers: ownerBlockers };

  for (let slot = 0; slot < state.limits.maxConcurrentPositions; slot += 1) {
    const lease = await createLease(slot, input.strategy, "execution", owner, input.ttlMs, nowMs);
    if (!lease) continue;
    const confirmation = evaluateRiskState(await getRiskState(nowMs)).strategies[input.strategy];
    if (!confirmation.canExecute) {
      await releaseExecutionLease(lease);
      return { acquired: false, reason: "risk-blocked", blockers: confirmation.blockers };
    }
    const confirmationOwnerBlockers = await liveOwnerBlockers();
    if (confirmationOwnerBlockers.length) {
      await releaseExecutionLease(lease);
      return { acquired: false, reason: "risk-blocked", blockers: confirmationOwnerBlockers };
    }
    return { acquired: true, lease };
  }
  return { acquired: false, reason: "capacity-reached", blockers: ["max-concurrent-positions-reached"] };
}

/**
 * Acquires capacity for an operation that can only reduce an already-open
 * position. Recovery deliberately remains available after Disarm, Emergency
 * Stop, a daily-loss breach, or disabling a strategy: those controls must stop
 * new exposure, never prevent an owned position from being flattened.
 *
 * Callers are responsible for proving ownership of the persisted position and
 * must not use this lease for an entry or for increasing exposure.
 */
export async function acquireRecoveryLease(input: {
  strategy: RiskStrategy;
  owner: string;
  ttlMs: number;
  now?: Date | number;
}): Promise<LeaseAcquisition> {
  const nowMs = new Date(input.now ?? new Date()).getTime();
  const owner = input.owner.trim();
  if (!RISK_STRATEGIES.includes(input.strategy) || !owner || owner.length > 200 || !Number.isInteger(input.ttlMs) || input.ttlMs < 100 || input.ttlMs > 300_000) {
    throw new RiskControlError("Invalid recovery lease request", "INVALID_STATE");
  }

  // This Bitget build deliberately ships only the Triangle execution adapter.
  // A legacy strategy record must never route its exchange-specific recovery
  // logic into Bitget after a project migration.
  const runtimeBlocker = strategyRuntimeBlocker(input.strategy, currentRuntimeEnvironment());
  if (runtimeBlocker) {
    return { acquired: false, reason: "risk-blocked", blockers: [runtimeBlocker] };
  }

  try {
    await acquireLiveOwner();
  } catch (error) {
    const mapped = asRiskControlError(error);
    if (mapped instanceof RiskControlError) {
      return { acquired: false, reason: "risk-blocked", blockers: mapped.blockers };
    }
    throw mapped;
  }

  const state = await getRiskState(nowMs);
  for (let slot = 0; slot < state.limits.maxConcurrentPositions; slot += 1) {
    const lease = await createLease(slot, input.strategy, "recovery", owner, input.ttlMs, nowMs);
    if (lease) return { acquired: true, lease };
  }
  return { acquired: false, reason: "capacity-reached", blockers: ["max-concurrent-positions-reached"] };
}

export async function renewExecutionLease(lease: Pick<ExecutionLease, "slot" | "token">, ttlMs: number, now: Date | number = new Date()) {
  if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 300_000) return false;
  if ((await liveOwnerBlockers()).length) return false;
  const target = leasePath(lease.slot);
  const current = await readLease(lease.slot);
  if (!current || current.token !== lease.token || Date.parse(current.expiresAt) <= new Date(now).getTime()) return false;
  const replacement = { ...current, expiresAt: iso(new Date(now).getTime() + ttlMs) };
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(replacement), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const check = await readLease(lease.slot);
  if (!check || check.token !== lease.token) {
    await rm(temp, { force: true });
    return false;
  }
  await rename(temp, target);
  return true;
}

export async function releaseExecutionLease(
  lease: Pick<ExecutionLease, "slot" | "token">,
  now: Date | number = new Date()
) {
  if (!Number.isInteger(lease.slot) || lease.slot < 0 || lease.slot >= MAX_LEASE_SLOTS) return false;
  const current = await readLease(lease.slot);
  if (!current || current.token !== lease.token) return false;
  await rm(leasePath(lease.slot), { force: true });
  const state = await getRiskState(now);
  if (!state.masterArmed && (await listExecutionLeases(now)).length === 0) {
    await releaseLiveOwner().catch(() => undefined);
  }
  return true;
}

async function releaseLiveOwnerIfIdle(now: Date | number = new Date()) {
  if ((await listExecutionLeases(now)).length > 0) return false;
  return releaseLiveOwner().catch(() => false);
}

export async function listExecutionLeases(now: Date | number = new Date()): Promise<PublicExecutionLease[]> {
  const nowMs = new Date(now).getTime();
  const leases = await Promise.all(Array.from({ length: MAX_LEASE_SLOTS }, (_, slot) => readLease(slot)));
  return leases
    .filter((lease): lease is ExecutionLease => Boolean(lease && Date.parse(lease.expiresAt) > nowMs))
    .map(({ token: _token, ...lease }) => lease);
}

export async function getRiskControlSnapshot(now: Date | number = new Date()): Promise<RiskControlSnapshot> {
  const state = await getRiskState(now);
  return {
    state,
    evaluation: evaluateRiskState(state),
    activeLeases: await listExecutionLeases(now)
  };
}
