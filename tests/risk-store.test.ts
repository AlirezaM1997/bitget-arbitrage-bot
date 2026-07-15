import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATCH } from "@/app/api/risk/route";
import { POST as EXECUTE_TRIANGLE } from "@/app/api/live/execute/route";
import {
  acquireExecutionLease,
  acquireRecoveryLease,
  armRiskControl,
  configureRiskState,
  emergencyStopRiskControl,
  getRiskControlSnapshot,
  getRiskState,
  recordRealizedPnl,
  releaseExecutionLease,
  resetRiskControl
} from "@/lib/risk/store";
import {
  LiveOwnerError,
  acquireLiveOwner,
  assertLiveOwnerForOrder,
  getLiveOwnerStatus,
  liveOwnerAccountFingerprint,
  liveOwnerLockPath,
  releaseLiveOwner
} from "@/lib/runtime/live-owner";
import { applyBitgetRuntimeSettings } from "@/lib/bitget-runtime-settings";

let directory = "";
const savedEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  LIVE_EXECUTION_TEST_OVERRIDE: process.env.LIVE_EXECUTION_TEST_OVERRIDE,
  LIVE_OWNER_DIR: process.env.LIVE_OWNER_DIR,
  BITGET_API_BASE: process.env.BITGET_API_BASE,
  BITGET_API_KEY: process.env.BITGET_API_KEY,
  BITGET_API_SECRET: process.env.BITGET_API_SECRET,
  BITGET_API_PASSPHRASE: process.env.BITGET_API_PASSPHRASE
};

const ready = {
  positionStateReady: true,
  recoveryReady: true,
  executionAdapterReady: true
};

beforeEach(async () => {
  directory = path.join(tmpdir(), `bitget-risk-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  process.env.RISK_STATE_PATH = path.join(directory, "risk-state.json");
  process.env.RISK_EXECUTION_LEASE_PATH = path.join(directory, "execution");
  process.env.RISK_TIME_ZONE = "Asia/Tehran";
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  process.env.LIVE_EXECUTION_TEST_OVERRIDE = "ALLOW_NON_PRODUCTION_LIVE_EXECUTION_FOR_TESTS";
  process.env.LIVE_OWNER_DIR = path.join(directory, "live-owner");
  process.env.BITGET_API_BASE = "https://api.bitget.com";
  process.env.BITGET_API_KEY = "risk-test-api-key";
  process.env.BITGET_API_SECRET = "risk-test-api-secret";
  process.env.BITGET_API_PASSPHRASE = "risk-test-passphrase";
  applyBitgetRuntimeSettings({ bitgetAccountMode: "uta", bitgetDemoTrading: false });
});

afterEach(async () => {
  await releaseLiveOwner();
  delete process.env.RISK_STATE_PATH;
  delete process.env.RISK_EXECUTION_LEASE_PATH;
  delete process.env.RISK_TIME_ZONE;
  restoreEnvironment("NODE_ENV", savedEnvironment.NODE_ENV);
  restoreEnvironment("LIVE_EXECUTION_TEST_OVERRIDE", savedEnvironment.LIVE_EXECUTION_TEST_OVERRIDE);
  restoreEnvironment("LIVE_OWNER_DIR", savedEnvironment.LIVE_OWNER_DIR);
  restoreEnvironment("BITGET_API_BASE", savedEnvironment.BITGET_API_BASE);
  restoreEnvironment("BITGET_API_KEY", savedEnvironment.BITGET_API_KEY);
  restoreEnvironment("BITGET_API_SECRET", savedEnvironment.BITGET_API_SECRET);
  restoreEnvironment("BITGET_API_PASSPHRASE", savedEnvironment.BITGET_API_PASSPHRASE);
  await rm(directory, { recursive: true, force: true });
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function makeGapReady(now = Date.parse("2026-07-12T12:00:00.000Z")) {
  await configureRiskState({
    strategies: { gapTrading: { enabled: true, readiness: ready } }
  }, now);
  await armRiskControl(now);
}

describe("persistent risk control", () => {
  test("starts fail-closed and persists a complete strategy readiness matrix", async () => {
    const state = await getRiskState(Date.parse("2026-07-12T12:00:00.000Z"));
    expect(state.masterArmed).toBe(false);
    expect(state.emergencyStop.active).toBe(false);
    expect(state.daily.realizedPnlToman).toBe(0);
    expect(state.daily.lossToman).toBe(0);
    expect(state.recordedPnlKeys).toEqual([]);
    expect(state.limits.maxConsecutiveLosses).toBe(1);
    expect(state.strategies.triangle).toMatchObject({
      enabled: true,
      readiness: {
        positionStateReady: true,
        recoveryReady: true,
        executionAdapterReady: true
      }
    });
    expect("crossQuote" in state.strategies).toBe(false);
    for (const strategy of ["gapTrading", "imbalance"] as const) {
      expect(state.strategies[strategy].readiness).toMatchObject({
        positionStateReady: false,
        recoveryReady: false,
        executionAdapterReady: false
      });
    }
    expect(Object.entries(state.strategies).filter(([name]) => name !== "triangle").every(([, strategy]) => !strategy.enabled)).toBe(true);
    expect((await getRiskControlSnapshot()).evaluation.canExecute).toBe(false);
  });

  test("migrates legacy Market Making risk state without enabling Gap Trading", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const legacy = {
      version: 1,
      masterArmed: false,
      emergencyStop: { active: false, reason: null, triggeredAt: null },
      daily: { date: "2026-07-12", realizedPnlToman: 0, lossToman: 0, tradeCount: 0, consecutiveLosses: 0 },
      limits: { maxDailyLossToman: 100_000, maxConcurrentPositions: 1 },
      strategies: Object.fromEntries([
        "triangle", "crossQuote", "pairs", "stablecoin", "marketMaking", "imbalance"
      ].map(name => [name, { enabled: name === "marketMaking", readiness: ready }])),
      updatedAt: new Date(now).toISOString()
    };
    await Bun.write(process.env.RISK_STATE_PATH!, JSON.stringify(legacy));

    const state = await getRiskState(now);
    expect("marketMaking" in state.strategies).toBe(false);
    expect("crossQuote" in state.strategies).toBe(false);
    expect("pairs" in state.strategies).toBe(false);
    expect("stablecoin" in state.strategies).toBe(false);
    expect(state.strategies.gapTrading).toMatchObject({
      enabled: false,
      readiness: { positionStateReady: false, recoveryReady: false, executionAdapterReady: false }
    });
  });

  test("normalizes a risk file after removed engines disappear from the strategy map", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const currentFormat = {
      version: 1,
      masterArmed: false,
      emergencyStop: { active: false, reason: null, triggeredAt: null },
      daily: { date: "2026-07-12", realizedPnlToman: 0, lossToman: 0, tradeCount: 0, consecutiveLosses: 0 },
      recordedPnlKeys: [],
      limits: { maxDailyLossToman: 100_000, maxConcurrentPositions: 1, maxConsecutiveLosses: 1 },
      strategies: {
        triangle: { enabled: true, readiness: ready },
        gapTrading: { enabled: true, readiness: ready },
        imbalance: { enabled: true, readiness: ready }
      },
      updatedAt: new Date(now).toISOString()
    };
    await Bun.write(process.env.RISK_STATE_PATH!, JSON.stringify(currentFormat));

    const state = await getRiskState(now);
    expect(Object.keys(state.strategies).sort()).toEqual(["aiAgent", "gapTrading", "imbalance", "triangle"]);
    expect(state.strategies.aiAgent.enabled).toBe(false);
    expect(state.strategies.gapTrading.enabled).toBe(true);
    expect(state.strategies.imbalance.enabled).toBe(true);
  });

  test("arms only after an enabled strategy passes every readiness gate", async () => {
    await armRiskControl(Date.parse("2026-07-12T12:00:00.000Z"));
    const snapshot = await getRiskControlSnapshot(Date.parse("2026-07-12T12:00:00.000Z"));
    expect(snapshot.state.masterArmed).toBe(true);
    expect(snapshot.evaluation.strategies.triangle.canExecute).toBe(true);
    expect("crossQuote" in snapshot.evaluation.strategies).toBe(false);
  });

  test("latches an emergency stop and reset does not silently re-arm", async () => {
    await makeGapReady();
    await emergencyStopRiskControl("operator-test", Date.parse("2026-07-12T12:01:00.000Z"));
    let state = await getRiskState(Date.parse("2026-07-12T12:01:00.000Z"));
    expect(state.masterArmed).toBe(false);
    expect(state.emergencyStop).toMatchObject({ active: true, reason: "operator-test" });
    await resetRiskControl(Date.parse("2026-07-12T12:02:00.000Z"));
    state = await getRiskState(Date.parse("2026-07-12T12:02:00.000Z"));
    expect(state.emergencyStop.active).toBe(false);
    expect(state.masterArmed).toBe(false);
  });

  test("retains the live owner during Emergency Stop until an active Triangle lease is released", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    await armRiskControl(now);
    const acquisition = await acquireExecutionLease({ strategy: "triangle", owner: "active-cycle", ttlMs: 5_000, now });
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) throw new Error("Expected a Triangle lease");

    await emergencyStopRiskControl("operator-stop-during-cycle", now + 100);
    expect(await assertLiveOwnerForOrder()).toBe(true);
    expect((await getLiveOwnerStatus()).heldByThisProcess).toBe(true);

    expect(await releaseExecutionLease(acquisition.lease, now + 200)).toBe(true);
    expect((await getLiveOwnerStatus()).heldByThisProcess).toBe(false);
  });

  test("does not drop the live owner when the Tehran risk day rolls during an active cycle", async () => {
    const beforeMidnight = Date.parse("2026-07-12T20:29:30.000Z");
    const afterMidnight = beforeMidnight + 60_000;
    await armRiskControl(beforeMidnight);
    const acquisition = await acquireExecutionLease({
      strategy: "triangle",
      owner: "midnight-cycle",
      ttlMs: 120_000,
      now: beforeMidnight
    });
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) throw new Error("Expected a Triangle lease");

    const rolled = await getRiskState(afterMidnight);
    expect(rolled.masterArmed).toBe(false);
    expect(await assertLiveOwnerForOrder()).toBe(true);

    expect(await releaseExecutionLease(acquisition.lease, afterMidnight)).toBe(true);
    expect((await getLiveOwnerStatus()).heldByThisProcess).toBe(false);
  });

  test("keeps risk-reducing recovery available while entry execution is stopped", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    await emergencyStopRiskControl("flatten-open-position", now);

    const entry = await acquireExecutionLease({ strategy: "gapTrading", owner: "entry-worker", ttlMs: 5_000, now });
    expect(entry).toMatchObject({
      acquired: false,
      reason: "risk-blocked",
      blockers: expect.arrayContaining(["master-not-armed", "emergency-stop-active"])
    });

    const recovery = await acquireRecoveryLease({ strategy: "triangle", owner: "position:42", ttlMs: 5_000, now });
    expect(recovery.acquired).toBe(true);
    if (!recovery.acquired) throw new Error("Expected a recovery lease");
    expect(recovery.lease).toMatchObject({ strategy: "triangle", purpose: "recovery", owner: "position:42" });
    expect(await releaseExecutionLease(recovery.lease)).toBe(true);
  });

  test("blocks legacy engines while keeping the Triangle execution and recovery lanes available", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    await configureRiskState({ strategies: { gapTrading: { enabled: true } } }, now);
    await armRiskControl(now);
    const entry = await acquireExecutionLease({ strategy: "gapTrading", owner: "gap-entry", ttlMs: 5_000, now });
    expect(entry).toMatchObject({
      acquired: false,
      blockers: expect.arrayContaining(["execution-adapter-not-ready"])
    });
    const triangleEntry = await acquireExecutionLease({ strategy: "triangle", owner: "triangle-entry", ttlMs: 5_000, now });
    expect(triangleEntry.acquired).toBe(true);
    if (triangleEntry.acquired) await releaseExecutionLease(triangleEntry.lease, now);
    const recovery = await acquireRecoveryLease({ strategy: "triangle", owner: "triangle-position:7", ttlMs: 5_000, now });
    expect(recovery.acquired).toBe(true);
    if (recovery.acquired) await releaseExecutionLease(recovery.lease, now);
  });

  test("persists daily PnL and trips the loss circuit breaker", async () => {
    await configureRiskState({
      limits: { maxDailyLossToman: 10_000, maxConsecutiveLosses: 10 },
      strategies: { gapTrading: { enabled: true, readiness: ready } }
    }, Date.parse("2026-07-12T12:00:00.000Z"));
    await armRiskControl(Date.parse("2026-07-12T12:00:00.000Z"));
    await recordRealizedPnl(-4_000, Date.parse("2026-07-12T12:01:00.000Z"));
    await recordRealizedPnl(-6_000, Date.parse("2026-07-12T12:02:00.000Z"));
    const snapshot = await getRiskControlSnapshot(Date.parse("2026-07-12T12:02:00.000Z"));
    expect(snapshot.state.daily).toMatchObject({ realizedPnlToman: -10_000, lossToman: 10_000, tradeCount: 2, consecutiveLosses: 2 });
    expect(snapshot.state.masterArmed).toBe(false);
    expect(snapshot.state.emergencyStop.reason).toBe("daily-loss-limit-breached");
    expect(snapshot.evaluation.dailyLossBreached).toBe(true);
  });

  test("records a retried PnL key once and stops after consecutive losses", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    await configureRiskState({
      limits: { maxDailyLossToman: 1_000_000, maxConsecutiveLosses: 2 },
      strategies: { gapTrading: { enabled: true, readiness: ready } }
    }, now);
    await armRiskControl(now);
    await recordRealizedPnl(-1_000, now + 1_000, { executionId: "execution-42" });
    await recordRealizedPnl(-1_000, now + 2_000, { executionId: "execution-42" });
    let state = await getRiskState(now + 2_000);
    expect(state.daily).toMatchObject({
      realizedPnlToman: -1_000,
      lossToman: 1_000,
      tradeCount: 1,
      consecutiveLosses: 1,
    });
    expect(state.recordedPnlKeys).toEqual(["execution-42"]);
    expect(state.masterArmed).toBe(true);

    await recordRealizedPnl(-500, now + 3_000, { idempotencyKey: "pnl:execution-43" });
    state = await getRiskState(now + 3_000);
    expect(state.daily.tradeCount).toBe(2);
    expect(state.daily.consecutiveLosses).toBe(2);
    expect(state.masterArmed).toBe(false);
    expect(state.emergencyStop.reason).toBe("consecutive-loss-limit-breached");
    expect((await getRiskControlSnapshot(now + 3_000)).evaluation.consecutiveLossBreached).toBe(true);
  });

  test("keeps PnL idempotency keys across the Tehran day rollover", async () => {
    const firstDay = Date.parse("2026-07-12T12:00:00.000Z");
    await recordRealizedPnl(2_500, firstDay, "execution-cross-midnight");
    const nextDay = Date.parse("2026-07-13T12:00:00.000Z");
    await recordRealizedPnl(2_500, nextDay, "execution-cross-midnight");
    const state = await getRiskState(nextDay);
    expect(state.daily).toMatchObject({ tradeCount: 0, realizedPnlToman: 0 });
    expect(state.recordedPnlKeys).toEqual(["execution-cross-midnight"]);
  });

  test("requires an explicit test override and fences the live owner token", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    delete process.env.LIVE_EXECUTION_TEST_OVERRIDE;
    await expect(acquireLiveOwner()).rejects.toMatchObject({
      code: "LIVE_ENVIRONMENT_BLOCKED",
      blocker: "production-runtime-required"
    } satisfies Partial<LiveOwnerError>);

    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.LIVE_EXECUTION_TEST_OVERRIDE = "ALLOW_NON_PRODUCTION_LIVE_EXECUTION_FOR_TESTS";
    const acquired = await acquireLiveOwner();
    expect(acquired.newlyAcquired).toBe(true);
    expect(await assertLiveOwnerForOrder()).toBe(true);
    expect(await getLiveOwnerStatus()).toMatchObject({ heldByThisProcess: true, locked: true, stale: false });
    expect(await releaseLiveOwner()).toBe(true);
    await expect(assertLiveOwnerForOrder()).rejects.toMatchObject({ blocker: "live-owner-not-held" });
  });

  test("binds the live owner to dashboard account and Demo API settings", async () => {
    await acquireLiveOwner();
    const mainnetFingerprint = liveOwnerAccountFingerprint();
    applyBitgetRuntimeSettings({ bitgetAccountMode: "classic", bitgetDemoTrading: true });
    expect(liveOwnerAccountFingerprint()).not.toBe(mainnetFingerprint);
    await expect(acquireLiveOwner()).rejects.toMatchObject({
      blocker: "live-owner-account-settings-changed"
    });
  });

  test("rejects a second runtime and takes over only after the owner process dies", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { acquireLiveOwner } from "./lib/runtime/live-owner.ts";
        await acquireLiveOwner();
        console.log("LIVE_OWNER_READY");
        await new Promise(() => {});
      `],
      cwd: process.cwd(),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe"
    });
    const reader = child.stdout.getReader();
    const output = await Promise.race([
      reader.read().then(result => new TextDecoder().decode(result.value)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("child live owner did not start")), 5_000))
    ]);
    expect(output).toContain("LIVE_OWNER_READY");
    await expect(acquireLiveOwner()).rejects.toMatchObject({ blocker: "live-owner-held-by-another-runtime" });

    child.kill();
    await child.exited;
    const takeover = await acquireLiveOwner();
    expect(takeover.newlyAcquired).toBe(true);
    expect(await getLiveOwnerStatus()).toMatchObject({ heldByThisProcess: true, pid: process.pid });
  });

  test("never steals a stale heartbeat from the same verified live process", async () => {
    const lockPath = liveOwnerLockPath();
    await mkdir(path.dirname(lockPath), { recursive: true });
    const old = "2026-01-01T00:00:00.000Z";
    await Bun.write(lockPath, JSON.stringify({
      version: 1,
      accountFingerprint: liveOwnerAccountFingerprint(),
      pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      buildId: "stale-heartbeat-test",
      token: randomUUID(),
      acquiredAt: old,
      heartbeatAt: old
    }));

    await expect(acquireLiveOwner()).rejects.toMatchObject({
      blocker: "live-owner-held-by-another-runtime"
    });
  });

  test("atomically rolls daily counters and disarms at the Tehran day boundary", async () => {
    const firstDay = Date.parse("2026-07-12T12:00:00.000Z");
    await makeGapReady(firstDay);
    await recordRealizedPnl(5_000, firstDay);
    const nextDay = Date.parse("2026-07-13T12:00:00.000Z");
    const state = await getRiskState(nextDay);
    expect(state.masterArmed).toBe(false);
    expect(state.daily).toMatchObject({
      date: "2026-07-13",
      realizedPnlToman: 0,
      lossToman: 0,
      tradeCount: 0,
      consecutiveLosses: 0
    });
    const persisted = JSON.parse(await readFile(process.env.RISK_STATE_PATH!, "utf8")) as { daily: { date: string } };
    expect(persisted.daily.date).toBe("2026-07-13");
  });

  test("uses exclusive filesystem leases and releases only with the owner token", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    await makeGapReady(now);
    const [first, second] = await Promise.all([
      acquireExecutionLease({ strategy: "triangle", owner: "worker-a", ttlMs: 5_000, now }),
      acquireExecutionLease({ strategy: "triangle", owner: "worker-b", ttlMs: 5_000, now })
    ]);
    const acquired = [first, second].filter(result => result.acquired);
    const blocked = [first, second].filter(result => !result.acquired);
    expect(acquired).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ reason: "capacity-reached" });
    if (!acquired[0]?.acquired) throw new Error("Expected one lease");
    expect(await releaseExecutionLease({ slot: acquired[0].lease.slot, token: randomUUID() }, now)).toBe(false);
    expect(await releaseExecutionLease(acquired[0].lease, now)).toBe(true);
    const next = await acquireExecutionLease({ strategy: "triangle", owner: "worker-c", ttlMs: 5_000, now });
    expect(next.acquired).toBe(true);
    if (next.acquired) await releaseExecutionLease(next.lease, now);
  });

  test("allows an expired lease to be replaced", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    await makeGapReady(now);
    const first = await acquireExecutionLease({ strategy: "triangle", owner: "worker-a", ttlMs: 100, now });
    expect(first.acquired).toBe(true);
    const second = await acquireExecutionLease({ strategy: "triangle", owner: "worker-b", ttlMs: 1_000, now: now + 101 });
    expect(second.acquired).toBe(true);
    if (first.acquired) expect(await releaseExecutionLease(first.lease, now + 101)).toBe(false);
    if (second.acquired) expect(await releaseExecutionLease(second.lease, now + 101)).toBe(true);
  });

  test("disables the removed dashboard risk configuration endpoint", async () => {
    const response = await PATCH(new Request("http://localhost/api/risk", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost",
        "x-risk-action": "bitget-dashboard"
      },
      body: JSON.stringify({
        strategies: { triangle: { readiness: { recoveryReady: false } } }
      })
    }));
    expect(response.status).toBe(410);
    const state = await getRiskState();
    expect(state.strategies.triangle.readiness.recoveryReady).toBe(true);
  });

  test("keeps the removed risk endpoint ineffective for every origin", async () => {
    const response = await PATCH(new Request("http://localhost/api/risk", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "https://evil.example",
        "x-risk-action": "bitget-dashboard"
      },
      body: JSON.stringify({ limits: { maxDailyLossToman: 1 } })
    }));
    expect(response.status).toBe(410);
    expect((await getRiskState()).limits.maxDailyLossToman).toBe(25);
  });

  test("blocks a direct Triangle execution request before any exchange call", async () => {
    const response = await EXECUTE_TRIANGLE(new Request("http://localhost/api/live/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-live-action": "bitget-dashboard",
        origin: "http://localhost",
        host: "localhost"
      },
      body: JSON.stringify({})
    }));
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ code: "RISK_BLOCKED" });
  });
});
