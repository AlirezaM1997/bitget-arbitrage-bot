import {
  appendExecutionEvent,
  listExecutionEvents,
  type AppendExecutionEventInput,
  type ExecutionLedgerEvent
} from "@/lib/execution-ledger";
import {
  failLiveExecution,
  getUnfinishedLiveExecutions,
  type UnfinishedLiveExecution
} from "@/lib/opportunity-store";
import { emergencyStopRiskControl, getRiskState } from "@/lib/risk/store";

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const EXCHANGE_FACING_EVENT_TYPES = new Set<ExecutionLedgerEvent["type"]>([
  "SUBMITTING",
  "ORDER_ACKNOWLEDGED",
  "FILL",
  "RECOVERY_STARTED",
  "RECOVERY_COMPLETED",
  "COMPLETED",
  "PNL_RECORDED",
  "MANUAL_REVIEW"
]);

export type TriangleStartupAuditResult = {
  safeToStart: boolean;
  code: "clear" | "abandoned-before-submit" | "manual-review" | "pending-not-stale" | "audit-failed" | "skipped";
  abandonedExecutionIds: number[];
  manualReviewExecutionIds: number[];
  pendingExecutionIds: number[];
  emergencyStopTriggered: boolean;
};

export type TriangleStartupAuditDependencies = {
  listUnfinished(): Promise<UnfinishedLiveExecution[]>;
  listLedgerEvents(executionId: string): Promise<ExecutionLedgerEvent[]>;
  appendLedgerEvent(input: AppendExecutionEventInput): Promise<unknown>;
  markFailed(id: number, reason: string): Promise<unknown>;
  emergencyStop(reason: string): Promise<unknown>;
  emergencyState(): Promise<{ active: boolean }>;
};

type AuditGlobal = typeof globalThis & {
  __bitgetTriangleStartupAudit?: Promise<TriangleStartupAuditResult>;
};

const defaultDependencies: TriangleStartupAuditDependencies = {
  listUnfinished: getUnfinishedLiveExecutions,
  listLedgerEvents: executionId => listExecutionEvents({ executionId, limit: 1_000 }),
  appendLedgerEvent: appendExecutionEvent,
  markFailed: (id, reason) => failLiveExecution(id, reason),
  emergencyStop: reason => emergencyStopRiskControl(reason),
  emergencyState: async () => ({ active: (await getRiskState()).emergencyStop.active })
};

export function triangleLedgerExecutionId(id: number) {
  return `triangle:${id}`;
}

export function shouldRunTriangleStartupAudit(environment: NodeJS.ProcessEnv = process.env) {
  return environment.NODE_ENV === "production"
    && environment.NEXT_PHASE !== "phase-production-build"
    && environment.NEXT_RUNTIME === "nodejs";
}

/**
 * Runs at most once per production Node process. The returned promise is the
 * startup fence: the Live scheduler must not start until it resolves safe.
 */
export function ensureTriangleStartupAuditCompleted() {
  // `skipped` describes an environment where startup reconciliation is not
  // allowed to run; it must never be interpreted as permission to execute.
  if (!shouldRunTriangleStartupAudit()) return Promise.resolve(emptyResult("skipped", false));
  const root = globalThis as AuditGlobal;
  root.__bitgetTriangleStartupAudit ??= auditTriangleStartupExecutions();
  return root.__bitgetTriangleStartupAudit;
}

/**
 * Reconciles durable local intent only. It deliberately never retries, sends,
 * or cancels an exchange order: any exchange-facing evidence is ambiguous
 * after a process restart and therefore activates Emergency Stop for review.
 */
export async function auditTriangleStartupExecutions(
  options: { nowMs?: number; staleAfterMs?: number } = {},
  dependencies: TriangleStartupAuditDependencies = defaultDependencies
): Promise<TriangleStartupAuditResult> {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = Math.max(0, Math.floor(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));
  try {
    const records = [...await dependencies.listUnfinished()].sort((left, right) => left.id - right.id);
    const abandonedExecutionIds: number[] = [];
    const manualReview: Array<{
      record: UnfinishedLiveExecution;
      ledgerTypes: ExecutionLedgerEvent["type"][];
      hasExchangeEvidence: boolean;
      timestampInvalid: boolean;
    }> = [];
    const pendingExecutionIds: number[] = [];

    for (const record of records) {
      const ledgerEvents = await executionLedgerEvents(record.id, dependencies);
      const ledgerTypes = [...new Set(ledgerEvents.map(event => event.type))].sort();
      const hasExchangeEvidence = record.ordersCorrupt
        || record.orders.length > 0
        || ledgerTypes.some(type => EXCHANGE_FACING_EVENT_TYPES.has(type));
      const timestampInvalid = !Number.isFinite(record.startedAt)
        || record.startedAt <= 0
        || record.startedAt > nowMs;

      if (record.status === "RUNNING" || hasExchangeEvidence || timestampInvalid) {
        manualReview.push({ record, ledgerTypes, hasExchangeEvidence, timestampInvalid });
        continue;
      }

      const ageMs = nowMs - record.startedAt;
      if (record.status === "PREPARING" && ageMs >= staleAfterMs) {
        const reason = "No order submitted: abandoned during server restart before submission";
        // Write the immutable decision first. If the mutable row update fails,
        // the same idempotency key is harmless and the next startup can retry.
        await dependencies.appendLedgerEvent({
          executionId: triangleLedgerExecutionId(record.id),
          engine: "triangle",
          type: "FAILED",
          idempotencyKey: `${triangleLedgerExecutionId(record.id)}:startup-abandoned:v1`,
          occurredAt: nowMs,
          payload: { reason: "abandoned-before-submit", status: record.status, orderCount: 0 }
        });
        await dependencies.markFailed(record.id, reason);
        abandonedExecutionIds.push(record.id);
        continue;
      }

      pendingExecutionIds.push(record.id);
    }

    if (manualReview.length) {
      const manualReviewExecutionIds = manualReview.map(item => item.record.id);
      const reason = `triangle-startup-manual-review:${manualReviewExecutionIds.join(",")}`.slice(0, 500);
      const emergencyStopTriggered = await ensureEmergencyStop(reason, dependencies);
      for (const item of manualReview) {
        await dependencies.appendLedgerEvent({
          executionId: triangleLedgerExecutionId(item.record.id),
          engine: "triangle",
          type: "MANUAL_REVIEW",
          idempotencyKey: `${triangleLedgerExecutionId(item.record.id)}:startup-manual-review:v1`,
          occurredAt: nowMs,
          payload: {
            reason: "unfinished-exchange-facing-execution",
            persistedStatus: item.record.status,
            orderCount: item.record.orders.length,
            ordersCorrupt: item.record.ordersCorrupt,
            hasExchangeEvidence: item.hasExchangeEvidence,
            timestampInvalid: item.timestampInvalid,
            ledgerTypes: item.ledgerTypes
          }
        });
      }
      return {
        safeToStart: false,
        code: "manual-review",
        abandonedExecutionIds,
        manualReviewExecutionIds,
        pendingExecutionIds,
        emergencyStopTriggered
      };
    }

    if (pendingExecutionIds.length) {
      return {
        safeToStart: false,
        code: "pending-not-stale",
        abandonedExecutionIds,
        manualReviewExecutionIds: [],
        pendingExecutionIds,
        emergencyStopTriggered: false
      };
    }

    return {
      safeToStart: true,
      code: abandonedExecutionIds.length ? "abandoned-before-submit" : "clear",
      abandonedExecutionIds,
      manualReviewExecutionIds: [],
      pendingExecutionIds: [],
      emergencyStopTriggered: false
    };
  } catch {
    const emergencyStopTriggered = await ensureEmergencyStop("triangle-startup-audit-failed", dependencies)
      .catch(() => false);
    return {
      ...emptyResult("audit-failed", false),
      emergencyStopTriggered
    };
  }
}

async function executionLedgerEvents(id: number, dependencies: TriangleStartupAuditDependencies) {
  const canonicalId = triangleLedgerExecutionId(id);
  const canonical = await dependencies.listLedgerEvents(canonicalId);
  // Accept the early numeric convention as well, so deployment of the new
  // canonical prefix cannot make an older SUBMITTING event invisible.
  const legacy = await dependencies.listLedgerEvents(String(id));
  return [...canonical, ...legacy];
}

async function ensureEmergencyStop(reason: string, dependencies: TriangleStartupAuditDependencies) {
  const current = await dependencies.emergencyState();
  if (current.active) return false;
  await dependencies.emergencyStop(reason);
  return true;
}

function emptyResult(code: TriangleStartupAuditResult["code"], safeToStart: boolean): TriangleStartupAuditResult {
  return {
    safeToStart,
    code,
    abandonedExecutionIds: [],
    manualReviewExecutionIds: [],
    pendingExecutionIds: [],
    emergencyStopTriggered: false
  };
}
