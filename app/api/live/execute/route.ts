import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotSettings } from "@/lib/bot-settings-store";
import {
  executeLive,
  liveSafetyRejectionReason,
  LiveExecutionRecoveredError,
  LiveManualInterventionError,
  type ExecutionLeg,
  type RecoveryPosition
} from "@/lib/bot/executor";
import type { BotSettings } from "@/lib/bot-settings";
import { bitgetClientSettings } from "@/lib/bitget-runtime-settings";
import type { Opportunity } from "@/lib/bot/types";
import { liveCapital, scan } from "@/lib/bot/scanner";
import { config } from "@/lib/config";
import { appendExecutionEvent, type ExecutionEventType } from "@/lib/execution-ledger";
import { BitgetClient } from "@/lib/exchanges/bitget";
import {
  completeLiveExecution,
  countUnsafeLiveExecutionRecords,
  createLiveExecutionAttempt,
  createLiveExecutionTrigger,
  failLiveExecution,
  markLiveExecutionPrepared,
  updateLiveExecutionOrders
} from "@/lib/opportunity-store";
import {
  acquireExecutionLease,
  emergencyStopRiskControl,
  evaluateRiskState,
  getRiskState,
  recordRealizedPnl,
  releaseExecutionLease,
  renewExecutionLease
} from "@/lib/risk/store";
import type { ExecutionLease } from "@/lib/risk/types";
import { triangleLedgerExecutionId } from "@/lib/runtime/triangle-startup-audit";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  triggerOpportunityId: z.string().trim().min(1).max(500).optional(),
  triggerRoute: z.array(z.string().trim().min(1).max(20)).length(4).optional(),
  triggerScannedAt: z.number().int().positive().optional()
}).strict().refine(value => Boolean(value.triggerOpportunityId) === Boolean(value.triggerRoute), {
  message: "triggerOpportunityId and triggerRoute must be sent together"
});

export async function POST(request: Request) {
  if (!isDashboardRequest(request)) {
    return NextResponse.json({ error: "درخواست اجرای واقعی فقط از همین برنامه پذیرفته می‌شود." }, { status: 403 });
  }

  let executionId: number | undefined;
  let lease: ExecutionLease | undefined;
  // Becomes true only after the durable pre-submit intent is written. From
  // that point onward an exchange order may exist even if a later HTTP/DB
  // operation fails, so every unclassified error must stop new entries.
  let exchangeIntentPersisted = false;
  try {
    const body = requestSchema.parse(await request.json());
    // Reconciliation is a per-request entry fence as well as a startup fence:
    // manually resetting Emergency Stop must never bypass prior exposure.
    if (await countUnsafeLiveExecutionRecords() > 0) {
      return NextResponse.json({
        error: "A previous Bitget execution still requires reconciliation.",
        code: "UNRESOLVED_LIVE_EXECUTION"
      }, { status: 423 });
    }
    // Execution limits are authoritative on the server; the browser cannot
    // loosen safety fields per request.
    const settings = await getBotSettings();
    const acquisition = await acquireExecutionLease({
      strategy: "triangle",
      owner: `triangle:${crypto.randomUUID()}`,
      ttlMs: 300_000
    });
    if (!acquisition.acquired) {
      if (acquisition.reason === "capacity-reached") {
        return NextResponse.json({ status: "busy", blockers: acquisition.blockers });
      }
      return NextResponse.json({
        error: "اجرای واقعی آربیتراژ مثلثی توسط کنترل ریسک سرور متوقف شده است.",
        code: "RISK_BLOCKED",
        blockers: acquisition.blockers
      }, { status: 423 });
    }
    lease = acquisition.lease;
    assertBitgetLiveRouteConfiguration(settings);

    const triggerOpportunityId = body.triggerOpportunityId;
    const triggerRoute = body.triggerRoute;
    const client = new BitgetClient(bitgetClientSettings(settings));
    const capital = await liveCapital(settings, client);
    if (capital.lte(0)) throw new Error("موجودی آزاد USDT برای معامله کافی نیست.");

    if (triggerOpportunityId && triggerRoute) {
      executionId = await createLiveExecutionTrigger({
        routeKey: triggerOpportunityId,
        route: triggerRoute,
        requestedInputToman: capital.toNumber()
      });
      await appendTriangleEvent(executionId, "INTENT", "intent", {
        source: "dashboard-trigger",
        route: triggerRoute,
        requestedInputToman: capital.toString()
      });
    }

    const result = await scan(capital, settings, client);
    const { best, triggerCandidate } = selectLiveOpportunityForExecution(
      result.opportunities,
      settings,
      { triggerOpportunityId, triggerRoute }
    );

    if (!best) {
      const reason = triggerCandidate?.rejectionReason
        ?? "فرصت در بازبینی نهایی Live ناپدید شد یا عمق کافی نداشت.";
      if (executionId !== undefined) {
        await failLiveExecution(executionId, `بدون ارسال سفارش: ${reason}`);
        await appendTriangleEvent(executionId, "FAILED", "no-order", {
          reason,
          noOrderSubmitted: true
        }).catch(() => undefined);
      }
      return NextResponse.json({
        status: triggerOpportunityId ? "rejected" : "no-opportunity",
        executionId,
        reason,
        capitalToman: capital.toString()
      });
    }

    executionId ??= await createLiveExecutionAttempt(best);
    const currentExecutionId = executionId;
    await appendTriangleEvent(currentExecutionId, "INTENT", "intent", {
      source: triggerOpportunityId ? "dashboard-trigger" : "server-scheduler",
      route: best.route,
      requestedInputToman: best.requestedInputToman.toString(),
      plannedInputToman: best.inputToman.toString(),
      plannedOutputToman: best.outputToman.toString(),
      plannedProfitToman: best.netProfitToman.toString(),
      plannedProfitBps: best.profitBps.toString()
    });

    const execution = await executeLive(best, settings, client, {
      onPrepared: async opportunity => {
        await markLiveExecutionPrepared(currentExecutionId, opportunity);
        await appendTriangleEvent(currentExecutionId, "PREPARED", "prepared", {
          route: opportunity.route,
          inputToman: opportunity.inputToman.toString(),
          outputToman: opportunity.outputToman.toString(),
          profitToman: opportunity.netProfitToman.toString(),
          profitBps: opportunity.profitBps.toString()
        });
      },
      onBeforeOrder: async () => {
        if (!lease || !await renewExecutionLease(lease, 300_000)) {
          throw new Error("مجوز انحصاری اجرا پیش از ارسال سفارش از دست رفت.");
        }
        const risk = evaluateRiskState(await getRiskState()).strategies.triangle;
        if (!risk.canExecute) {
          throw new Error(`کنترل ریسک چرخه را متوقف کرد: ${risk.blockers.join(",")}`);
        }
      },
      onBeforeRecoveryOrder: async () => {
        // Recovery may reduce exposure after an Emergency Stop, but it still
        // requires the same execution lease and process owner.
        if (!lease || !await renewExecutionLease(lease, 300_000)) {
          throw new Error("مجوز بازیابی از دست رفت؛ بررسی دستی دارایی لازم است.");
        }
      },
      // This hook is awaited immediately before the HTTP order request. If the
      // durable write fails, the exchange call is never made.
      onOrderIntent: async event => {
        await appendTriangleEvent(
          currentExecutionId,
          "SUBMITTING",
          `submit:${event.clientOrderId}`,
          {
            stage: event.stage,
            clientOrderId: event.clientOrderId,
            symbol: event.symbol,
            side: event.side,
            amountBase: event.amountBase.toString(),
            protectedPrice: event.expectedPrice.toString()
          }
        );
        exchangeIntentPersisted = true;
      },
      onLeg: async (leg, completedLegs) => {
        // Exchange-facing evidence is written before the mutable dashboard row.
        await appendLegEvents(currentExecutionId, leg);
        await updateLiveExecutionOrders(currentExecutionId, completedLegs);
      },
      onRecoveryStarted: event => appendTriangleEvent(
        currentExecutionId,
        "RECOVERY_STARTED",
        `recovery-start:${recoveryFingerprint(event.inventory)}`,
        { reason: event.reason, inventory: serializePositions(event.inventory) }
      ),
      onRecoveryCompleted: recovery => appendTriangleEvent(
        currentExecutionId,
        "RECOVERY_COMPLETED",
        `recovery-complete:${recoveryFingerprint(recovery.startedInventory)}`,
        {
          reason: recovery.reason,
          recoveredToman: recovery.recoveredToman.toString(),
          residualValueToman: recovery.residualValueToman.toString(),
          economicRecoveredToman: recovery.economicRecoveredToman.toString(),
          residualInventory: serializePositions(recovery.residualInventory)
        }
      ),
      onManualInterventionRequired: async event => {
        try {
          await appendTriangleEvent(currentExecutionId, "MANUAL_REVIEW", "manual-review", {
            reason: event.reason,
            inventory: serializePositions(event.inventory)
          });
        } finally {
          await emergencyStopRiskControl(event.reason);
        }
      }
    }, { books: result.books, options: result.options });

    const warnings = await finalizeSuccessfulTriangleExecution(currentExecutionId, execution);

    return NextResponse.json({
      status: "executed",
      executionId: currentExecutionId,
      route: best.route,
      requestedInputToman: execution.requestedInputToman.toString(),
      inputToman: execution.inputToman.toString(),
      outputToman: execution.outputToman.toString(),
      profitToman: execution.profitToman.toString(),
      realizedOutputToman: execution.realizedOutputToman.toString(),
      realizedProfitToman: execution.realizedProfitToman.toString(),
      residualValueToman: execution.residualValueToman.toString(),
      residualInventory: serializePositions(execution.residualInventory),
      fullySettled: execution.fullySettled,
      legs: execution.legs,
      warnings
    });
  } catch (error) {
    let message = errorMessage(error, "خطا در اجرای معامله واقعی");
    let code: string | undefined;
    let recovery: {
      inputToman: string;
      outputToman: string;
      realizedOutputToman: string;
      profitToman: string;
      realizedProfitToman: string;
      residualValueToman: string;
      residualInventory: Array<{ asset: string; amount: string }>;
      fullySettled: boolean;
    } | undefined;
    let preserveUnfinishedExecution = false;

    if (error instanceof LiveExecutionRecoveredError) {
      const economicPnl = error.recovery.economicRecoveredToman.minus(error.recovery.actualInputToman);
      const realizedPnl = error.recovery.recoveredToman.minus(error.recovery.actualInputToman);
      code = error.code;
      recovery = {
        inputToman: error.recovery.actualInputToman.toString(),
        outputToman: error.recovery.economicRecoveredToman.toString(),
        realizedOutputToman: error.recovery.recoveredToman.toString(),
        profitToman: economicPnl.toString(),
        realizedProfitToman: realizedPnl.toString(),
        residualValueToman: error.recovery.residualValueToman.toString(),
        residualInventory: serializePositions(error.recovery.residualInventory),
        fullySettled: error.recovery.residualInventory.length === 0
      };
      message = `${error.message} سود/زیان اقتصادی بازیابی: ${economicPnl.toFixed(0)} USDT`;
      if (executionId !== undefined) {
        const accounting = await persistRecoveredTrianglePnl(executionId, {
          economicPnl: economicPnl.toNumber(),
          pnlToman: recovery.profitToman,
          realizedPnlToman: recovery.realizedProfitToman,
          residualValueToman: recovery.residualValueToman,
          fullySettled: recovery.fullySettled
        });
        preserveUnfinishedExecution = !accounting.safeToClose;
        if (accounting.warnings.length) message = `${message} ${accounting.warnings.join(" ")}`;
        if (preserveUnfinishedExecution) {
          await appendTriangleEvent(executionId, "MANUAL_REVIEW", "recovery-accounting-review", {
            reason: "recovery-pnl-accounting-incomplete",
            warnings: accounting.warnings
          }).catch(() => undefined);
        }
      }
      if (executionId === undefined) {
        // Defensive fallback: a recovered order should always have a durable
        // attempt id, but never leave Live armed if that invariant is broken.
        await emergencyStopRiskControl("triangle-cycle-failed-without-execution-id").catch(() => undefined);
      }
    } else if (error instanceof LiveManualInterventionError) {
      code = error.code;
      await emergencyStopRiskControl(error.message).catch(() => undefined);
    }

    if (exchangeIntentPersisted && !(error instanceof LiveExecutionRecoveredError) && !(error instanceof LiveManualInterventionError)) {
      await emergencyStopRiskControl("triangle-post-submit-or-finalization-failed").catch(() => undefined);
    }

    if (executionId !== undefined) {
      if (!preserveUnfinishedExecution) {
        await failLiveExecution(executionId, message, recovery ? {
          actualOutputToman: Number(recovery.outputToman),
          actualProfitToman: Number(recovery.profitToman),
          realizedOutputToman: Number(recovery.realizedOutputToman),
          realizedProfitToman: Number(recovery.realizedProfitToman),
          residualValueToman: Number(recovery.residualValueToman),
          residualInventory: recovery.residualInventory,
          fullySettled: recovery.fullySettled
        } : undefined).catch(() => undefined);
      }
      await appendTriangleEvent(executionId, "FAILED", `failed:${code ?? "generic"}`, {
        code: code ?? null,
        reason: message,
        recovery: recovery ?? null,
        mutableRowPreservedForReview: preserveUnfinishedExecution
      }).catch(() => undefined);
    }
    return NextResponse.json({ error: message, code, recovery, executionId }, { status: code ? 409 : 400 });
  } finally {
    if (lease) await releaseExecutionLease(lease).catch(() => undefined);
  }
}

type SuccessfulTriangleExecution = Awaited<ReturnType<typeof executeLive>>;

export type TriangleFinalizationDependencies = {
  recordPnl(pnl: number, now: Date, idempotency: { idempotencyKey: string }): Promise<unknown>;
  appendEvent(
    executionId: number,
    type: ExecutionEventType,
    suffix: string,
    payload: Record<string, unknown>
  ): Promise<unknown>;
  complete(executionId: number, execution: SuccessfulTriangleExecution): Promise<unknown>;
  emergencyStop(reason: string): Promise<unknown>;
  now: () => Date;
};

const triangleFinalizationDependencies: TriangleFinalizationDependencies = {
  recordPnl: recordRealizedPnl,
  appendEvent: appendTriangleEvent,
  complete: completeLiveExecution,
  emergencyStop: emergencyStopRiskControl,
  now: () => new Date()
};

export type RecoveredTrianglePnl = {
  economicPnl: number;
  pnlToman: string;
  realizedPnlToman: string;
  residualValueToman: string;
  fullySettled: boolean;
};

/**
 * A recovered failed cycle is terminal only after its economic PnL is durable.
 * If accounting cannot be proven, the mutable row deliberately remains
 * RUNNING so both the per-request fence and startup audit require review.
 */
export async function persistRecoveredTrianglePnl(
  executionId: number,
  recovery: RecoveredTrianglePnl,
  dependencies: Pick<
    TriangleFinalizationDependencies,
    "recordPnl" | "appendEvent" | "emergencyStop" | "now"
  > = triangleFinalizationDependencies
) {
  const warnings: string[] = [];
  const pnlKey = `triangle:${executionId}:pnl`;
  try {
    await dependencies.recordPnl(
      recovery.economicPnl,
      dependencies.now(),
      { idempotencyKey: pnlKey }
    );
  } catch (accountingError) {
    warnings.push(errorMessage(accountingError, "Recovered-cycle risk accounting failed."));
    await dependencies.emergencyStop("triangle-recovery-risk-accounting-failed").catch(stopError => {
      warnings.push(errorMessage(stopError, "Emergency Stop persistence also failed."));
    });
    return { safeToClose: false, warnings, riskIdempotencyKey: pnlKey };
  }

  try {
    await dependencies.appendEvent(executionId, "PNL_RECORDED", "pnl", {
      accountingBasis: recovery.fullySettled ? "cash-settled-recovery" : "economic-recovery-with-marked-dust",
      pnlToman: recovery.pnlToman,
      realizedPnlToman: recovery.realizedPnlToman,
      residualValueToman: recovery.residualValueToman,
      riskIdempotencyKey: pnlKey
    });
  } catch (auditError) {
    warnings.push(errorMessage(auditError, "Recovered-cycle PnL ledger write failed."));
    await dependencies.emergencyStop("triangle-recovery-pnl-ledger-write-failed")
      .catch(stopError => {
        warnings.push(errorMessage(stopError, "Emergency Stop persistence also failed."));
      });
    // Risk PnL is durable, but incomplete immutable evidence still requires a
    // RUNNING row and startup/manual reconciliation.
    return { safeToClose: false, warnings, riskIdempotencyKey: pnlKey };
  }

  try {
    await dependencies.emergencyStop("triangle-cycle-failed-after-automatic-recovery");
  } catch (stopError) {
    warnings.push(errorMessage(stopError, "Recovered-cycle Emergency Stop persistence failed."));
    return { safeToClose: false, warnings, riskIdempotencyKey: pnlKey };
  }

  return { safeToClose: true, warnings, riskIdempotencyKey: pnlKey };
}

/**
 * Crash-consistency barrier for a successful exchange cycle.
 *
 * The mutable execution row may become COMPLETED only after the authoritative
 * risk PnL mutation is durable. A crash therefore leaves either a RUNNING row
 * for startup reconciliation or PnL that is already included in risk limits.
 */
export async function finalizeSuccessfulTriangleExecution(
  executionId: number,
  execution: SuccessfulTriangleExecution,
  dependencies: TriangleFinalizationDependencies = triangleFinalizationDependencies
) {
  const warnings: string[] = [];
  const pnlKey = `triangle:${executionId}:pnl`;

  try {
    await dependencies.recordPnl(
      execution.profitToman.toNumber(),
      dependencies.now(),
      { idempotencyKey: pnlKey }
    );
  } catch (accountingError) {
    try {
      await dependencies.emergencyStop("triangle-risk-accounting-failed");
    } finally {
      // Never close the mutable row while daily loss counters are unknown.
      throw accountingError;
    }
  }

  try {
    await dependencies.appendEvent(executionId, "PNL_RECORDED", "pnl", {
      accountingBasis: execution.fullySettled ? "cash-settled" : "economic-with-marked-dust",
      pnlToman: execution.profitToman.toString(),
      realizedPnlToman: execution.realizedProfitToman.toString(),
      residualValueToman: execution.residualValueToman.toString(),
      riskIdempotencyKey: pnlKey
    });
  } catch (auditError) {
    warnings.push(errorMessage(auditError, "Recording the Triangle PnL ledger event failed."));
    // Completion is allowed only after this audit failure durably disarms Live.
    await dependencies.emergencyStop("triangle-pnl-ledger-write-failed");
  }

  if (execution.profitToman.lt(0)) {
    await dependencies.emergencyStop("triangle-realized-loss-circuit-breaker");
  }

  try {
    await dependencies.complete(executionId, execution);
  } catch (completionError) {
    try {
      await dependencies.emergencyStop("triangle-execution-completion-write-failed");
    } finally {
      throw completionError;
    }
  }

  try {
    await dependencies.appendEvent(executionId, "COMPLETED", "completed", {
      requestedInputToman: execution.requestedInputToman.toString(),
      inputToman: execution.inputToman.toString(),
      economicOutputToman: execution.outputToman.toString(),
      economicProfitToman: execution.profitToman.toString(),
      realizedOutputToman: execution.realizedOutputToman.toString(),
      realizedProfitToman: execution.realizedProfitToman.toString(),
      residualValueToman: execution.residualValueToman.toString(),
      residualInventory: serializePositions(execution.residualInventory),
      fullySettled: execution.fullySettled
    });
  } catch (auditError) {
    warnings.push(errorMessage(auditError, "Recording the Triangle completion ledger event failed."));
    await dependencies.emergencyStop("triangle-completion-ledger-write-failed").catch(stopError => {
      warnings.push(errorMessage(stopError, "Emergency Stop persistence also failed."));
    });
  }

  return warnings;
}

async function appendTriangleEvent(
  executionId: number,
  type: ExecutionEventType,
  suffix: string,
  payload: Record<string, unknown>
) {
  return appendExecutionEvent({
    executionId: triangleLedgerExecutionId(executionId),
    engine: "triangle",
    type,
    idempotencyKey: `triangle:${executionId}:${suffix}`.slice(0, 300),
    payload
  });
}

async function appendLegEvents(executionId: number, leg: ExecutionLeg) {
  const orderKey = (leg.clientOrderId || leg.orderId || `${leg.symbol}:${leg.side}`).slice(0, 120);
  if (leg.orderId) {
    await appendTriangleEvent(executionId, "ORDER_ACKNOWLEDGED", `ack:${orderKey}`, {
      stage: leg.stage ?? "cycle",
      clientOrderId: leg.clientOrderId ?? null,
      orderId: leg.orderId,
      symbol: leg.symbol,
      side: leg.side,
      status: leg.status
    });
  }
  const hasFinalAmounts = leg.matchedAmount !== undefined && leg.unmatchedAmount !== undefined;
  const terminalWithoutFill = ["done", "closed", "canceled", "cancelled", "failed", "rejected"]
    .includes(leg.status.trim().toLowerCase());
  if (hasFinalAmounts && (Number(leg.matchedAmount) > 0 || terminalWithoutFill)) {
    const stateKey = `${leg.status}:${leg.matchedAmount}:${leg.unmatchedAmount}`.slice(0, 120);
    await appendTriangleEvent(executionId, "FILL", `fill:${orderKey}:${stateKey}`, {
      ...leg,
      stage: leg.stage ?? "cycle"
    });
  }
}

function serializePositions(positions: RecoveryPosition[]) {
  return positions.map(position => ({ asset: position.asset, amount: position.amount.toString() }));
}

function recoveryFingerprint(positions: RecoveryPosition[]) {
  return serializePositions(positions)
    .map(position => `${position.asset}-${position.amount}`)
    .join("_")
    .slice(0, 100) || "empty";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export type BitgetLiveRouteConfiguration = Pick<
  typeof config,
  | "BITGET_API_BASE"
  | "BITGET_WS_PUBLIC"
  | "BITGET_API_KEY"
  | "BITGET_API_SECRET"
  | "BITGET_API_PASSPHRASE"
> & Pick<BotSettings, "bitgetAccountMode" | "bitgetDemoTrading">;

/**
 * The route is the final entry fence before authenticated exchange activity.
 * Keep this check independent from the client so a future adapter change
 * cannot silently permit a custom host or omit Bitget's passphrase credential.
 */
export function bitgetLiveRouteConfigurationBlocker(
  configuration: BitgetLiveRouteConfiguration
) {
  let apiUrl: URL;
  try {
    apiUrl = new URL(configuration.BITGET_API_BASE);
  } catch {
    return "official-bitget-mainnet-required";
  }
  if (
    apiUrl.protocol !== "https:"
    || apiUrl.hostname.toLowerCase() !== "api.bitget.com"
    || apiUrl.port
    || apiUrl.username
    || apiUrl.password
    || (apiUrl.pathname !== "/" && apiUrl.pathname !== "")
    || apiUrl.search
    || apiUrl.hash
  ) return "official-bitget-mainnet-required";
  let websocketUrl: URL;
  try {
    websocketUrl = new URL(configuration.BITGET_WS_PUBLIC);
  } catch {
    return "official-bitget-websocket-required";
  }
  if (
    websocketUrl.protocol !== "wss:"
    || websocketUrl.hostname.toLowerCase() !== "ws.bitget.com"
    || websocketUrl.port
    || websocketUrl.username
    || websocketUrl.password
    || websocketUrl.pathname !== "/v2/ws/public"
    || websocketUrl.search
    || websocketUrl.hash
  ) return "official-bitget-websocket-required";
  if (!(["classic", "uta"] as const).includes(configuration.bitgetAccountMode)) return "bitget-account-mode-invalid";
  if (
    !configuration.BITGET_API_KEY?.trim()
    || !configuration.BITGET_API_SECRET?.trim()
    || !configuration.BITGET_API_PASSPHRASE?.trim()
  ) return "bitget-live-credentials-missing";
  return undefined;
}

export function selectLiveOpportunityForExecution(
  opportunities: Opportunity[],
  settings: BotSettings,
  trigger: { triggerOpportunityId?: string; triggerRoute?: string[] } = {}
) {
  // Evaluate the final Live margin for every fresh candidate before ranking.
  // Otherwise a high-ranked but unsafe candidate can hide the next safe one.
  for (const opportunity of opportunities) {
    const rejection = liveSafetyRejectionReason(opportunity, settings);
    if (opportunity.executable && rejection) {
      opportunity.executable = false;
      opportunity.rejectionReason = rejection;
    }
  }

  const triggerCandidate = trigger.triggerOpportunityId
    ? opportunities.find(item => item.id === trigger.triggerOpportunityId)
    : undefined;
  const triggerRouteMatches = !triggerCandidate || !trigger.triggerRoute
    || triggerCandidate.route.length === trigger.triggerRoute.length
      && triggerCandidate.route.every((asset, index) => asset === trigger.triggerRoute?.[index]);
  const best = trigger.triggerOpportunityId
    ? triggerCandidate?.executable && triggerRouteMatches ? triggerCandidate : undefined
    : opportunities
      .filter(item => item.executable)
      .sort((left, right) => right.netProfitToman.comparedTo(left.netProfitToman))[0];
  return { best, triggerCandidate };
}

function assertBitgetLiveRouteConfiguration(settings: BotSettings) {
  const blocker = bitgetLiveRouteConfigurationBlocker({
    ...config,
    bitgetAccountMode: settings.bitgetAccountMode,
    bitgetDemoTrading: settings.bitgetDemoTrading
  });
  if (blocker) throw new Error(`Bitget Live configuration rejected: ${blocker}`);
}

export function isDashboardRequest(request: Request) {
  if (request.headers.get("x-live-action") !== "bitget-dashboard") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
