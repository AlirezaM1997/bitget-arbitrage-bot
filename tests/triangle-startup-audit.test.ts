import { describe, expect, test } from "bun:test";
import type { ExecutionLedgerEvent } from "@/lib/execution-ledger";
import {
  auditTriangleStartupExecutions,
  ensureTriangleStartupAuditCompleted,
  shouldRunTriangleStartupAudit,
  type TriangleStartupAuditDependencies
} from "@/lib/runtime/triangle-startup-audit";
import type { UnfinishedLiveExecution } from "@/lib/opportunity-store";

const NOW = 1_800_000_000_000;

function record(overrides: Partial<UnfinishedLiveExecution> = {}): UnfinishedLiveExecution {
  return {
    id: 7,
    status: "PREPARING",
    startedAt: NOW - 10 * 60_000,
    orders: [],
    ordersCorrupt: false,
    ...overrides
  };
}

function ledgerEvent(type: ExecutionLedgerEvent["type"], executionId = "triangle:7"): ExecutionLedgerEvent {
  return {
    id: 1,
    executionId,
    engine: "triangle",
    type,
    idempotencyKey: `${executionId}:${type}`,
    occurredAt: NOW - 1_000,
    payload: {},
    previousHash: "GENESIS",
    eventHash: "hash"
  };
}

function dependencies(input: {
  records?: UnfinishedLiveExecution[];
  events?: Record<string, ExecutionLedgerEvent[]>;
  emergencyActive?: boolean;
  failList?: boolean;
} = {}) {
  const calls: string[] = [];
  const records = input.records ?? [];
  const deps: TriangleStartupAuditDependencies = {
    listUnfinished: async () => {
      calls.push("list");
      if (input.failList) throw new Error("database unavailable");
      return records;
    },
    listLedgerEvents: async executionId => {
      calls.push(`events:${executionId}`);
      return input.events?.[executionId] ?? [];
    },
    appendLedgerEvent: async event => { calls.push(`append:${event.type}:${event.idempotencyKey}`); },
    markFailed: async id => { calls.push(`failed:${id}`); },
    emergencyStop: async reason => { calls.push(`stop:${reason}`); },
    emergencyState: async () => ({ active: Boolean(input.emergencyActive) })
  };
  return { deps, calls };
}

describe("Triangle startup audit", () => {
  test("marks only stale pre-submit intent as abandoned, without Emergency Stop", async () => {
    const fixture = dependencies({
      records: [record()],
      events: { "triangle:7": [ledgerEvent("PREPARED")] }
    });
    const result = await auditTriangleStartupExecutions({ nowMs: NOW }, fixture.deps);

    expect(result.safeToStart).toBe(true);
    expect(result.code).toBe("abandoned-before-submit");
    expect(result.abandonedExecutionIds).toEqual([7]);
    expect(fixture.calls.find(call => call.startsWith("append:FAILED"))).toBeTruthy();
    expect(fixture.calls.indexOf(fixture.calls.find(call => call.startsWith("append:FAILED"))!))
      .toBeLessThan(fixture.calls.indexOf("failed:7"));
    expect(fixture.calls.some(call => call.startsWith("stop:"))).toBe(false);
  });

  test("RUNNING is never retried and enters durable manual review", async () => {
    const fixture = dependencies({ records: [record({ status: "RUNNING" })] });
    const result = await auditTriangleStartupExecutions({ nowMs: NOW }, fixture.deps);

    expect(result.safeToStart).toBe(false);
    expect(result.manualReviewExecutionIds).toEqual([7]);
    expect(fixture.calls).toContain("stop:triangle-startup-manual-review:7");
    expect(fixture.calls.some(call => call.startsWith("append:MANUAL_REVIEW"))).toBe(true);
    expect(fixture.calls.some(call => call.startsWith("failed:"))).toBe(false);
  });

  test("SUBMITTING evidence or persisted orders always enters manual review", async () => {
    const withLedger = dependencies({
      records: [record()],
      events: { "triangle:7": [ledgerEvent("SUBMITTING")] }
    });
    const ledgerResult = await auditTriangleStartupExecutions({ nowMs: NOW }, withLedger.deps);
    expect(ledgerResult.code).toBe("manual-review");

    const withOrders = dependencies({ records: [record({ id: 8, orders: [{ orderId: "123" }] })] });
    const orderResult = await auditTriangleStartupExecutions({ nowMs: NOW }, withOrders.deps);
    expect(orderResult.code).toBe("manual-review");
    expect(orderResult.manualReviewExecutionIds).toEqual([8]);
    expect(withOrders.calls.some(call => call.startsWith("failed:"))).toBe(false);
  });

  test("fresh PREPARING blocks the scheduler without mutating or stopping", async () => {
    const fixture = dependencies({ records: [record({ startedAt: NOW - 1_000 })] });
    const result = await auditTriangleStartupExecutions({ nowMs: NOW }, fixture.deps);
    expect(result.code).toBe("pending-not-stale");
    expect(result.safeToStart).toBe(false);
    expect(result.pendingExecutionIds).toEqual([7]);
    expect(fixture.calls.some(call => call.startsWith("append:") || call.startsWith("failed:") || call.startsWith("stop:"))).toBe(false);
  });

  test("invalid or future persisted timestamps fail closed into manual review", async () => {
    const fixture = dependencies({ records: [record({ startedAt: NOW + 1 })] });
    const result = await auditTriangleStartupExecutions({ nowMs: NOW }, fixture.deps);
    expect(result.code).toBe("manual-review");
    expect(result.manualReviewExecutionIds).toEqual([7]);
    expect(fixture.calls).toContain("stop:triangle-startup-manual-review:7");
  });

  test("is idempotent after an abandoned row leaves the unfinished set", async () => {
    const records = [record()];
    const fixture = dependencies({ records });
    fixture.deps.markFailed = async id => {
      fixture.calls.push(`failed:${id}`);
      records.splice(0, records.length);
    };
    expect((await auditTriangleStartupExecutions({ nowMs: NOW }, fixture.deps)).safeToStart).toBe(true);
    expect((await auditTriangleStartupExecutions({ nowMs: NOW }, fixture.deps)).code).toBe("clear");
    expect(fixture.calls.filter(call => call.startsWith("failed:"))).toHaveLength(1);
  });

  test("audit failure is fail-closed and activates Emergency Stop", async () => {
    const fixture = dependencies({ failList: true });
    const result = await auditTriangleStartupExecutions({ nowMs: NOW }, fixture.deps);
    expect(result).toMatchObject({ safeToStart: false, code: "audit-failed", emergencyStopTriggered: true });
    expect(fixture.calls).toContain("stop:triangle-startup-audit-failed");
  });

  test("runs only in a production Node runtime and never in the build worker", () => {
    expect(shouldRunTriangleStartupAudit({ NODE_ENV: "production", NEXT_RUNTIME: "nodejs" })).toBe(true);
    expect(shouldRunTriangleStartupAudit({ NODE_ENV: "test", NEXT_RUNTIME: "nodejs" })).toBe(false);
    expect(shouldRunTriangleStartupAudit({ NODE_ENV: "production", NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build" })).toBe(false);
    expect(shouldRunTriangleStartupAudit({ NODE_ENV: "production", NEXT_RUNTIME: "edge" })).toBe(false);
  });

  test("a skipped startup audit is fail-closed", async () => {
    const result = await ensureTriangleStartupAuditCompleted();
    expect(result).toMatchObject({ safeToStart: false, code: "skipped" });
  });
});
