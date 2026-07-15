import { describe, expect, test } from "bun:test";
import {
  createLiveSchedulerRuntime,
  runLiveSchedulerTick,
  type LiveSchedulerDependencies
} from "@/lib/runtime/live-scheduler";

function dependencies(overrides: Partial<LiveSchedulerDependencies> = {}): LiveSchedulerDependencies {
  return {
    isProduction: () => true,
    now: () => 1_000,
    getSettings: async () => ({ scanIntervalMs: 1_000 }),
    getRiskSnapshot: async () => ({
      state: {
        masterArmed: true,
        strategies: { triangle: { enabled: true } }
      },
      evaluation: {
        strategies: { triangle: { canExecute: true, blockers: [] } }
      }
    } as never),
    getOwnerStatus: async () => ({
      heldByThisProcess: true,
      locked: true,
      accountFingerprint: "test",
      pid: 1,
      buildId: "test",
      acquiredAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      stale: false
    }),
    assertOwner: async () => true,
    executeTriangle: async () => Response.json({ status: "no-opportunity" }),
    ...overrides
  };
}

describe("production Triangle Live scheduler", () => {
  test("never delegates outside production", async () => {
    let delegated = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      isProduction: () => false,
      executeTriangle: async () => {
        delegated += 1;
        return Response.json({ status: "executed" });
      }
    }));

    expect(event.outcome).toBe("not-production");
    expect(delegated).toBe(0);
  });

  test("does not inspect ownership or delegate while Master Live is disarmed", async () => {
    let ownerChecks = 0;
    let delegated = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getRiskSnapshot: async () => ({
        state: { masterArmed: false, strategies: { triangle: { enabled: true } } },
        evaluation: { strategies: { triangle: { canExecute: false, blockers: ["master-not-armed"] } } }
      } as never),
      getOwnerStatus: async () => {
        ownerChecks += 1;
        throw new Error("must not be called");
      },
      executeTriangle: async () => {
        delegated += 1;
        return Response.json({ status: "executed" });
      }
    }));

    expect(event.outcome).toBe("master-disarmed");
    expect(ownerChecks).toBe(0);
    expect(delegated).toBe(0);
  });

  test("non-Triangle engines never become runnable", async () => {
    let ownerChecks = 0;
    let delegated = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getRiskSnapshot: async () => ({
        state: {
          masterArmed: true,
          strategies: {
            triangle: { enabled: false },
            aiAgent: { enabled: true },
            gapTrading: { enabled: true },
            imbalance: { enabled: true }
          }
        },
        evaluation: {
          strategies: {
            triangle: { canExecute: false, blockers: ["strategy-disabled"] },
            aiAgent: { canExecute: true, blockers: [] },
            gapTrading: { canExecute: true, blockers: [] },
            imbalance: { canExecute: true, blockers: [] }
          }
        }
      } as never),
      getOwnerStatus: async () => {
        ownerChecks += 1;
        throw new Error("must not be called");
      },
      executeTriangle: async () => {
        delegated += 1;
        return Response.json({ status: "executed" });
      }
    }));

    expect(event).toMatchObject({ outcome: "triangle-disabled", strategy: "triangle" });
    expect(ownerChecks).toBe(0);
    expect(delegated).toBe(0);
  });

  test("reports the Triangle blocker before checking ownership", async () => {
    let ownerChecks = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getRiskSnapshot: async () => ({
        state: { masterArmed: true, strategies: { triangle: { enabled: true } } },
        evaluation: { strategies: { triangle: { canExecute: false, blockers: ["recovery-not-ready"] } } }
      } as never),
      getOwnerStatus: async () => {
        ownerChecks += 1;
        throw new Error("must not be called");
      }
    }));

    expect(event).toMatchObject({
      outcome: "risk-blocked",
      strategy: "triangle",
      code: "recovery-not-ready"
    });
    expect(ownerChecks).toBe(0);
  });

  test("single-flight fence rejects a concurrent tick", async () => {
    let release!: () => void;
    let delegated = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runtime = createLiveSchedulerRuntime(0);
    const deps = dependencies({
      executeTriangle: async () => {
        delegated += 1;
        await pending;
        return Response.json({ status: "no-opportunity" });
      }
    });

    const first = runLiveSchedulerTick(runtime, deps);
    const second = await runLiveSchedulerTick(runtime, deps);
    expect(second.outcome).toBe("in-flight");
    expect(delegated).toBe(0);
    release();
    expect((await first).outcome).toBe("no-opportunity");
    expect(delegated).toBe(1);
    expect(runtime.inFlightToken).toBeNull();
  });

  test("loads interval, validates owner, and delegates only the internal Triangle route", async () => {
    let request: Request | undefined;
    let ownerAssertions = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getSettings: async () => ({ scanIntervalMs: 250 }),
      assertOwner: async () => { ownerAssertions += 1; },
      executeTriangle: async value => {
        request = value;
        return Response.json({ status: "executed", executionId: 9 });
      }
    }));

    expect(event).toMatchObject({ outcome: "executed", strategy: "triangle", httpStatus: 200 });
    expect(runtime.intervalMs).toBe(1_000);
    expect(ownerAssertions).toBe(1);
    expect(request?.url).toBe("http://bitget-internal/api/live/execute");
    expect(request?.headers.get("x-live-action")).toBe("bitget-dashboard");
    expect(request?.headers.get("host")).toBe("bitget-internal");
    expect(request?.headers.get("origin")).toBe("http://bitget-internal");
    expect(await request?.json()).toEqual({});
  });
});
