import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import Decimal from "decimal.js";
import type { IndependentAiMarketCandidate } from "@/lib/ai-agent/market-scanner";
import { scanAiMarketBooks } from "@/lib/ai-agent/scanner-service";
import { selectAiLiveCandidate } from "@/lib/ai-agent/live-policy";
import { recommendAiCapitalToman } from "@/lib/ai-agent/autopilot-profiles";
import type { BotSettings } from "@/lib/bot-settings";
import { getBotSettings } from "@/lib/bot-settings-store";
import { config } from "@/lib/config";
import { BitgetClient } from "@/lib/exchanges/bitget";
import type { OrderBook } from "@/lib/exchanges/types";
import {
  acquireExecutionLease,
  acquireRecoveryLease,
  emergencyStopRiskControl,
  evaluateRiskState,
  getRiskState,
  recordRealizedPnl,
  releaseExecutionLease,
  renewExecutionLease
} from "@/lib/risk/store";
import type { ExecutionLease, RiskEvaluation, RiskState } from "@/lib/risk/types";
import {
  acquireStrategyExecutionRecordLock,
  releaseStrategyExecutionRecordLock,
  type StrategyExecutionRecordLock
} from "@/lib/strategy-execution-lock";
import { scanOrderbookImbalance } from "./engine";
import { scanOrderbookGaps } from "./orderbook-gap";
import {
  createSpotPositionExecutionPlan,
  createAiSpotPositionExecutionPlan,
  deserializeSpotPositionExecutionPlan,
  executeSpotPosition,
  recoverKnownSpotExposure,
  serializeSpotPositionExecutionPlan,
  SpotPositionExecutionError,
  type SpotPositionExecutionClient,
  type SpotPositionExecutionHooks,
  type SpotPositionExecutionPlan,
  type SpotPositionExecutionResult,
  type SpotPositionStrategy
} from "./spot-position-executor";
import type { StrategyLabConfig, StrategySignal } from "./types";
import { recordOrderbookObservations } from "./orderbook-history";
import {
  addStrategyExecutionOrder,
  completeStrategyExecution,
  createStrategyExecution,
  failStrategyExecution,
  listStrategyExecutions,
  StrategyExecutionConflictError,
  transitionStrategyExecution,
  type StrategyExecutionState
} from "@/lib/strategy-execution-store";

const OFFICIAL_MAINNET_HOSTNAME = "api.bitget.com";

export type SpotPositionRouteKind = SpotPositionStrategy;
export type SpotPositionRouteCandidate = StrategySignal | IndependentAiMarketCandidate;

export type SpotPositionRouteDependencies = {
  getSettings(): Promise<BotSettings>;
  apiBaseUrl(): string;
  createClient(): SpotPositionExecutionClient;
  getAvailableToman(client: SpotPositionExecutionClient): Promise<Decimal>;
  scan(kind: SpotPositionRouteKind, books: OrderBook[], settings: BotSettings, now: number): SpotPositionRouteCandidate[];
  createPlan(kind: SpotPositionRouteKind, signal: SpotPositionRouteCandidate, settings: BotSettings, now: number): SpotPositionExecutionPlan;
  qualifyAiCandidate?(candidate: IndependentAiMarketCandidate, settings: BotSettings): Promise<{
    qualified: boolean;
    probability?: number;
    blockers: string[];
  }>;
  acquireLease: typeof acquireExecutionLease;
  acquireRecoveryLease: typeof acquireRecoveryLease;
  acquireRecordLock: typeof acquireStrategyExecutionRecordLock;
  releaseRecordLock: typeof releaseStrategyExecutionRecordLock;
  recordPnl: typeof recordRealizedPnl;
  renewLease: typeof renewExecutionLease;
  releaseLease: typeof releaseExecutionLease;
  getRiskState: typeof getRiskState;
  evaluateRisk(state: RiskState): RiskEvaluation;
  emergencyStop: typeof emergencyStopRiskControl;
  createExecution: typeof createStrategyExecution;
  transitionExecution: typeof transitionStrategyExecution;
  addOrder: typeof addStrategyExecutionOrder;
  completeExecution: typeof completeStrategyExecution;
  failExecution: typeof failStrategyExecution;
  listExecutions: typeof listStrategyExecutions;
  execute(plan: SpotPositionExecutionPlan, client: SpotPositionExecutionClient, hooks: SpotPositionExecutionHooks): Promise<SpotPositionExecutionResult>;
  recover(plan: SpotPositionExecutionPlan, amount: Decimal.Value, client: SpotPositionExecutionClient, hooks: SpotPositionExecutionHooks): ReturnType<typeof recoverKnownSpotExposure>;
  now(): number;
  randomId(): string;
};

export const defaultSpotPositionRouteDependencies: SpotPositionRouteDependencies = {
  getSettings: getBotSettings,
  apiBaseUrl: () => config.BITGET_API_BASE,
  createClient: () => new BitgetClient(),
  getAvailableToman: async client => {
    // The production dependency always creates BitgetClient. Keeping the
    // balance read injectable lets route tests stay exchange-independent while
    // preserving one authenticated client for books, balance and orders.
    const wallet = await (client as BitgetClient).getSpotTomanWallet();
    return wallet.available;
  },
  scan: (kind, books, settings, now) => {
    if (kind === "ai-autonomous") {
      return scanAiMarketBooks(books, settings, { now }).candidates;
    }
    const strategyConfig: StrategyLabConfig = {
      settings: settings.strategyLab,
      tomanTakerFeeBps: settings.tomanTakerFeeBps,
      usdtTakerFeeBps: settings.usdtTakerFeeBps,
      slippageBps: settings.slippageBufferBps,
      maxAgeMs: settings.orderbookMaxAgeMs
    };
    if (kind === "orderbook-gap") {
      const gap = settings.strategyLab.gapTrading;
      const orderbookHistory = recordOrderbookObservations(books, now, {
        maxAgeMs: Math.max(gap.sampleWindowMs, gap.maxPersistenceMs) + 5_000,
        maxSamples: Math.max(40, gap.minConfirmations * 4, gap.minOutcomeSamples * 3)
      });
      return scanOrderbookGaps(books, strategyConfig, now, { now, orderbookHistory });
    }
    const imbalance = settings.strategyLab.imbalance;
    const orderbookHistory = recordOrderbookObservations(books, now, {
      maxAgeMs: Math.max(imbalance.sampleWindowMs, imbalance.maxPersistenceMs) + 5_000,
      maxSamples: 40
    });
    return scanOrderbookImbalance(books, strategyConfig, now, { now, orderbookHistory });
  },
  createPlan: (kind, signal, settings, now) => {
    const common = {
      tomanTakerFeeBps: settings.tomanTakerFeeBps,
      slippageBps: settings.slippageBufferBps,
      liveSafetyBufferBps: settings.liveSafetyBufferBps,
      maxAgeMs: settings.orderbookMaxAgeMs,
      orderTimeoutMs: settings.orderTimeoutMs
    };
    if (kind === "ai-autonomous") {
      if (signal.kind !== "autonomous-market") {
        throw new SpotPositionExecutionError("AI execution requires an autonomous-market candidate", "INVALID_PLAN");
      }
      const ai = settings.aiAgent;
      const lifecycle = settings.strategyLab.imbalance;
      if (ai.scannerMinImbalanceRatio <= 1) {
        throw new SpotPositionExecutionError("AI Live requires Scanner Min Imbalance Ratio above 1", "INVALID_PLAN");
      }
      const exitRatio = Math.max(1, ai.scannerMinImbalanceRatio * 0.75);
      const maxLossToman = Math.min(
        lifecycle.maxLossToman,
        ai.maxLiveCapitalToman
      );
      const maxResidualToman = Math.min(lifecycle.maxResidualToman, maxLossToman);
      return createAiSpotPositionExecutionPlan(signal, {
        ...common,
        capitalToman: ai.maxLiveCapitalToman,
        maxSpreadBps: ai.scannerMaxSpreadBps,
        maxPriceImpactBps: ai.scannerMaxPriceImpactBps,
        depthUsagePercent: ai.scannerDepthUsagePercent,
        orderReserveBps: lifecycle.orderReserveBps,
        takeProfitBps: ai.takeProfitBps,
        stopLossBps: ai.stopLossBps,
        maxLossToman,
        maxResidualToman,
        maxHoldMs: ai.maxHoldMs,
        pollIntervalMs: lifecycle.pollIntervalMs,
        recoveryMaxSpreadBps: lifecycle.recoveryMaxSpreadBps,
        recoveryMaxPriceImpactBps: lifecycle.recoveryMaxPriceImpactBps,
        recoverySlippageBps: lifecycle.recoverySlippageBps,
        imbalance: {
          levels: ai.scannerLevels,
          levelWeightDecayPercent: ai.scannerLevelWeightDecayPercent,
          minRatio: ai.scannerMinImbalanceRatio,
          exitRatio,
          minVisibleDepthToman: ai.scannerMinVisibleDepthToman,
          maxTopLevelSharePercent: ai.scannerMaxTopLevelSharePercent,
          minMicropriceBiasBps: ai.scannerMinMicropriceBiasBps,
          minOrderFlowImbalance: ai.scannerMinOrderFlowImbalance,
          minLiquidityRetentionPercent: ai.scannerMinLiquidityRetentionPercent
        }
      }, now);
    }
    if (signal.kind === "autonomous-market") {
      throw new SpotPositionExecutionError("Engine execution cannot consume an autonomous AI candidate", "INVALID_PLAN");
    }
    if (kind === "orderbook-gap") {
      const strategy = settings.strategyLab.gapTrading;
      return createSpotPositionExecutionPlan(signal, {
        ...common,
        capitalToman: strategy.capitalToman,
        maxSpreadBps: strategy.maxSpreadBps,
        maxPriceImpactBps: strategy.maxPriceImpactBps,
        depthUsagePercent: strategy.depthUsagePercent,
        orderReserveBps: strategy.orderReserveBps,
        takeProfitBps: strategy.takeProfitBps,
        stopLossBps: strategy.stopLossBps,
        maxLossToman: strategy.maxLossToman,
        maxResidualToman: strategy.maxResidualToman,
        maxHoldMs: strategy.maxHoldMs,
        pollIntervalMs: strategy.pollIntervalMs,
        recoveryMaxSpreadBps: strategy.recoveryMaxSpreadBps,
        recoveryMaxPriceImpactBps: strategy.recoveryMaxPriceImpactBps,
        recoverySlippageBps: strategy.recoverySlippageBps,
        gap: {
          levels: strategy.levels,
          baselineLevels: strategy.baselineLevels,
          levelWeightDecayPercent: strategy.levelWeightDecayPercent,
          gapIndex: Number(signal.metrics.gapFromLevel) - 1,
          minGapBps: strategy.minGapBps,
          minGapZScore: strategy.minGapZScore,
          minGapRatio: strategy.minGapRatio,
          minOrderFlowImbalance: strategy.minOrderFlowImbalance,
          minLiquidityRetentionPercent: strategy.minBidLiquidityRetentionPercent
        }
      }, now);
    }
    const strategy = settings.strategyLab.imbalance;
    return createSpotPositionExecutionPlan(signal, {
      ...common,
      capitalToman: strategy.capitalToman,
      maxSpreadBps: strategy.maxSpreadBps,
      maxPriceImpactBps: strategy.maxPriceImpactBps,
      depthUsagePercent: strategy.depthUsagePercent,
      orderReserveBps: strategy.orderReserveBps,
      takeProfitBps: strategy.takeProfitBps,
      stopLossBps: strategy.stopLossBps,
      maxLossToman: strategy.maxLossToman,
      maxResidualToman: strategy.maxResidualToman,
      maxHoldMs: strategy.maxHoldMs,
      pollIntervalMs: strategy.pollIntervalMs,
      recoveryMaxSpreadBps: strategy.recoveryMaxSpreadBps,
      recoveryMaxPriceImpactBps: strategy.recoveryMaxPriceImpactBps,
      recoverySlippageBps: strategy.recoverySlippageBps,
      imbalance: {
        levels: strategy.levels,
        levelWeightDecayPercent: strategy.levelWeightDecayPercent,
        minRatio: strategy.minRatio,
        exitRatio: strategy.exitRatio,
        minVisibleDepthToman: strategy.minVisibleDepthToman,
        maxTopLevelSharePercent: strategy.maxTopLevelSharePercent,
        minMicropriceBiasBps: strategy.minMicropriceBiasBps,
        minOrderFlowImbalance: strategy.minOrderFlowImbalance,
        minLiquidityRetentionPercent: strategy.minDominantLiquidityRetentionPercent
      }
    }, now);
  },
  qualifyAiCandidate: async (candidate, settings) => {
    const result = await selectAiLiveCandidate({
      candidates: [candidate],
      settings: settings.aiAgent
    });
    return {
      qualified: result.selection?.candidate.id === candidate.id,
      probability: result.selection?.probability,
      blockers: result.blockers
    };
  },
  acquireLease: acquireExecutionLease,
  acquireRecoveryLease,
  acquireRecordLock: acquireStrategyExecutionRecordLock,
  releaseRecordLock: releaseStrategyExecutionRecordLock,
  recordPnl: recordRealizedPnl,
  renewLease: renewExecutionLease,
  releaseLease: releaseExecutionLease,
  getRiskState,
  evaluateRisk: evaluateRiskState,
  emergencyStop: emergencyStopRiskControl,
  createExecution: createStrategyExecution,
  transitionExecution: transitionStrategyExecution,
  addOrder: addStrategyExecutionOrder,
  completeExecution: completeStrategyExecution,
  failExecution: failStrategyExecution,
  listExecutions: listStrategyExecutions,
  execute: (plan, client, hooks) => executeSpotPosition(plan, client, hooks, { baseUrl: config.BITGET_API_BASE }),
  recover: (plan, amount, client, hooks) => recoverKnownSpotExposure(plan, amount, client, hooks, { baseUrl: config.BITGET_API_BASE }),
  now: Date.now,
  randomId: randomUUID
};

export async function handleSpotPositionRequest(
  request: Request,
  kind: SpotPositionRouteKind,
  dependencies: SpotPositionRouteDependencies = defaultSpotPositionRouteDependencies
) {
  if (!isDashboardStrategyRequest(request)) {
    return NextResponse.json({ error: "Strategy execution is accepted only from this dashboard" }, { status: 403 });
  }
  const inputSchema = z.object({ signalId: signalIdSchema(kind) }).strict();
  let input: z.infer<typeof inputSchema>;
  try { input = inputSchema.parse(await request.json()); } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Request body accepts only signalId", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const apiHostname = hostname(dependencies.apiBaseUrl());
  if (apiHostname !== OFFICIAL_MAINNET_HOSTNAME) {
    return NextResponse.json({
      error: `This execution foundation requires official Bitget Mainnet https://${OFFICIAL_MAINNET_HOSTNAME}`,
      code: "MAINNET_REQUIRED"
    }, { status: 423 });
  }

  let lease: ExecutionLease | undefined;
  let recordLock: StrategyExecutionRecordLock | undefined;
  let executionId: number | undefined;
  let executionState: StrategyExecutionState | undefined;
  let exposed = false;
  let aiProbability: number | undefined;
  try {
    // Prices, capital, limits and direction are always reconstructed from persisted server settings
    // and a fresh orderbook scan. The browser contributes only the signal identity.
    const settings = await dependencies.getSettings();
    if (kind === "ai-autonomous" && (!settings.aiAgent.enabled || settings.aiAgent.mode !== "live")) {
      return NextResponse.json({
        error: "Autonomous AI Live execution is disabled in server settings",
        code: "AI_LIVE_DISABLED"
      }, { status: 423 });
    }
    const client = dependencies.createClient();
    const scannedAt = dependencies.now();
    const books = await client.getAllOrderBooks();
    // Reject a disappeared/stale signal before making the authenticated wallet
    // call. If it still exists, the signal is scanned again at the final
    // balance-capped size below; this first pass is never execution authority.
    const preliminarySignal = findExecutableSpotSignal(
      dependencies.scan(kind, books, settings, scannedAt),
      kind,
      input.signalId
    );
    if (!preliminarySignal) {
      return NextResponse.json({
        status: "rejected",
        reason: "The requested signal is no longer an executable long Spot signal after a fresh server-side scan"
      }, { status: 409 });
    }

    if (kind === "ai-autonomous") {
      if (preliminarySignal.kind !== "autonomous-market") {
        throw new SpotPositionExecutionError("Fresh AI scan returned an incompatible candidate", "INVALID_PLAN");
      }
      const qualification = await (dependencies.qualifyAiCandidate
        ?? defaultSpotPositionRouteDependencies.qualifyAiCandidate!)(preliminarySignal, settings);
      if (!qualification.qualified) {
        return NextResponse.json({
          status: "rejected",
          reason: "The fresh candidate did not pass the locally trained AI Live policy",
          blockers: qualification.blockers
        }, { status: 409 });
      }
      aiProbability = qualification.probability;
    }

    const availableToman = await dependencies.getAvailableToman(client);
    if (!availableToman.isFinite() || availableToman.lt(0)) {
      throw new SpotPositionExecutionError("Available Spot USDT balance is invalid", "INVALID_PLAN");
    }
    const strategyCapitalToman = kind === "orderbook-gap"
      ? settings.strategyLab.gapTrading.capitalToman
      : kind === "ai-autonomous"
        ? recommendAiCapitalToman({
            maximumToman: settings.aiAgent.maxLiveCapitalToman,
            probability: aiProbability ?? settings.aiAgent.minLiveConfidencePercent / 100,
            minimumConfidencePercent: settings.aiAgent.minLiveConfidencePercent,
            profile: settings.aiAgent.autopilotProfile
          })
        : settings.strategyLab.imbalance.capitalToman;
    const capitalToman = Decimal.min(
      strategyCapitalToman,
      settings.maxTradeToman,
      availableToman.mul(settings.balanceUsagePercent).div(100)
    );
    if (capitalToman.lte(0)) {
      return NextResponse.json({
        status: "rejected",
        reason: "No usable free Spot USDT balance is available after server-side capital limits"
      }, { status: 409 });
    }
    const executionSettings = withSpotCapital(settings, kind, capitalToman.toNumber());
    const signal = findExecutableSpotSignal(
      dependencies.scan(kind, books, executionSettings, scannedAt),
      kind,
      input.signalId
    );
    if (!signal) {
      return NextResponse.json({
        status: "rejected",
        reason: "The requested signal is no longer an executable long Spot signal after a fresh server-side scan"
      }, { status: 409 });
    }
    if (kind === "ai-autonomous") {
      if (signal.kind !== "autonomous-market") {
        throw new SpotPositionExecutionError("Fresh AI scan returned an incompatible candidate", "INVALID_PLAN");
      }
      const qualification = await (dependencies.qualifyAiCandidate ?? defaultSpotPositionRouteDependencies.qualifyAiCandidate!)(signal, executionSettings);
      if (!qualification.qualified) {
        return NextResponse.json({
          status: "rejected",
          reason: "The fresh candidate did not pass the locally trained AI Live policy",
          blockers: qualification.blockers
        }, { status: 409 });
      }
      aiProbability = qualification.probability;
    }
    const plan = dependencies.createPlan(kind, signal, executionSettings, scannedAt);
    const riskStrategy = plan.riskStrategy;
    const acquisition = await dependencies.acquireLease({
      strategy: riskStrategy,
      owner: `spot-position:execution:${input.signalId}:${dependencies.randomId()}`,
      ttlMs: 300_000
    });
    if (!acquisition.acquired) {
      return NextResponse.json({
        error: "Execution is locked by server-side Risk Control",
        code: "RISK_BLOCKED",
        blockers: acquisition.blockers
      }, { status: acquisition.reason === "risk-blocked" ? 423 : 409 });
    }
    lease = acquisition.lease;

    const record = await dependencies.createExecution({
      strategy: riskStrategy,
      signalId: candidateId(signal),
      symbols: candidateSymbols(signal),
      direction: "USDT -> asset -> USDT (long Spot)",
      requestedCapitalToman: plan.capitalToman.toNumber(),
      plannedProfitToman: candidateEstimatedProfit(signal).toNumber(),
      metadata: {
        planId: plan.id,
        executionPlan: serializeSpotPositionExecutionPlan(plan),
        strategyKind: plan.strategy,
        signalScannedAt: signal.scannedAt,
        initialMetric: plan.initialMetric.toString(),
        entryEvidence: signal.metrics,
        aiProbability,
        maxHoldMs: plan.config.maxHoldMs,
        stopLossBps: plan.config.stopLossBps.toString(),
        maxLossToman: plan.config.maxLossToman.toString(),
        maxResidualToman: plan.config.maxResidualToman.toString(),
        environment: "official-bitget-mainnet"
      }
    });
    executionId = record.id;
    executionState = "DETECTED";
    const recordLockResult = await dependencies.acquireRecordLock({
      executionId,
      owner: `spot-position:execution:${record.id}`,
      ttlMs: 600_000
    });
    if (!recordLockResult.acquired) {
      throw new SpotPositionExecutionError("This persisted position is already owned by another worker", "ORDER_FAILED");
    }
    recordLock = recordLockResult.lock;

    const transition = async (to: StrategyExecutionState, note: string, metadata?: Record<string, unknown>) => {
      if (executionId === undefined || executionState === to) return;
      await dependencies.transitionExecution(executionId, to, { note, metadata });
      executionState = to;
    };
    await transition("REVALIDATING", "Fresh server-side entry revalidation started");

    const legIndex = { entry: 0, exit: 1, recovery: 2 } as const;
    const hooks: SpotPositionExecutionHooks = {
      onBeforeOrder: async ({ stage, quote, request: orderRequest }) => {
        if (!lease || !await dependencies.renewLease(lease, 300_000)) {
          throw new SpotPositionExecutionError(
            "Execution lease ownership was lost before order submission",
            "ORDER_STATE_UNKNOWN",
            stage !== "entry"
          );
        }
        if (stage === "entry") {
          const riskState = await dependencies.getRiskState();
          const blockers = dependencies.evaluateRisk(riskState).strategies[riskStrategy].blockers;
          if (blockers.length) throw new SpotPositionExecutionError(`Risk Control blocked entry: ${blockers.join(", ")}`, "ORDER_FAILED");
          if (executionState === "REVALIDATING") await transition("SUBMITTING", "Long Spot entry is being submitted");
        }
        await dependencies.addOrder(executionId!, {
          legIndex: legIndex[stage],
          symbol: quote.edge.book.symbol,
          side: quote.edge.side,
          status: "submitting",
          clientOrderId: orderRequest.clientOrderId,
          requestedAmount: orderRequest.amountBase.toString(),
          inputAsset: quote.edge.from,
          outputAsset: quote.edge.to,
          raw: { event: "before-submit", stage, expectedPrice: orderRequest.expectedPrice.toString() }
        });
      },
      onOrderSubmitted: async ({ stage, order, request: orderRequest }) => {
        exposed ||= stage === "entry";
        await dependencies.addOrder(executionId!, {
          legIndex: legIndex[stage],
          symbol: `${orderRequest.base}${orderRequest.quote}`,
          side: orderRequest.side,
          status: order.status,
          clientOrderId: orderRequest.clientOrderId,
          exchangeOrderId: order.id,
          requestedAmount: orderRequest.amountBase.toString(),
          filledAmount: order.matchedAmount.toString(),
          averagePrice: order.averagePrice.toString(),
          fee: order.fee.toString(),
          inputAsset: orderRequest.side === "BUY" ? orderRequest.quote : orderRequest.base,
          outputAsset: orderRequest.side === "BUY" ? orderRequest.base : orderRequest.quote,
          raw: { event: "submitted", stage, exchange: order.raw }
        });
      },
      onOrderFinalized: async ({ stage, leg }) => {
        exposed ||= stage === "entry" && leg.actualOutput.gt(0);
        await dependencies.addOrder(executionId!, {
          legIndex: legIndex[stage],
          symbol: leg.symbol,
          side: leg.side,
          status: leg.status,
          clientOrderId: leg.clientOrderId,
          exchangeOrderId: leg.orderId,
          requestedAmount: leg.submittedAmountBase.toString(),
          filledAmount: leg.matchedAmountBase.toString(),
          averagePrice: leg.averagePrice.toString(),
          fee: leg.fee.toString(),
          inputAsset: leg.inputAsset,
          outputAsset: leg.outputAsset,
          raw: {
            event: "finalized",
            stage,
            fullFill: leg.fullFill,
            unmatchedAmount: leg.unmatchedAmountBase.toString(),
            actualInput: leg.actualInput.toString(),
            actualOutput: leg.actualOutput.toString(),
            feeAsset: leg.feeAsset
          }
        });
        if (stage === "entry" && !leg.fullFill && executionState === "SUBMITTING") {
          await transition("PARTIALLY_FILLED", "Entry ended with a partial fill", { exchangeOrderId: leg.orderId });
        }
      },
      onPositionOpened: async ({ entry }) => {
        exposed ||= entry.actualOutput.gt(0);
        if (entry.fullFill && executionState === "SUBMITTING") {
          await transition("HEDGING", "Long Spot position opened; server exit controls are monitoring it", {
            entryOrderId: entry.orderId,
            assetAmount: entry.actualOutput.toString(),
            entryCostToman: entry.actualInput.toString()
          });
        }
      },
      onPositionCheck: async ({ heldMs }) => {
        if (!lease || !await dependencies.renewLease(lease, 300_000)) {
          throw new SpotPositionExecutionError("Execution lease was lost while the position was open", "ORDER_STATE_UNKNOWN", true);
        }
        const status = dependencies.evaluateRisk(await dependencies.getRiskState()).strategies[riskStrategy];
        return status.blockers.length ? `risk-control:${status.blockers.join(",")}:held-${heldMs}ms` : undefined;
      },
      onRecoveryStarted: async ({ assetAmount, reason }) => {
        if (executionState !== "RECOVERING") {
          await transition("RECOVERING", "Automatic USDT recovery started", { assetAmount: assetAmount.toString(), reason });
        }
      }
    };

    const result = await dependencies.execute(plan, client, hooks);
    await dependencies.completeExecution(executionId, {
      note: result.status === "recovered" ? "Position recovered to USDT" : "Position closed to USDT",
      actualOutputToman: result.outputToman.toNumber(),
      actualProfitToman: result.profitToman.toNumber(),
      metadata: {
        resultStatus: result.status,
        exitReason: result.exitReason,
        heldMs: result.heldMs,
        residualAssetAmount: result.residualAssetAmount.toString(),
        actualProfitBps: result.profitBps.toString(),
        pnlRecordedGlobally: true,
        environment: "mainnet"
      }
    });
    executionState = "CLOSED";
    exposed = result.residualAssetAmount.gt(0);
    await recordPnlOrStop(dependencies, riskStrategy, executionId, result.profitToman.toNumber());
    if (result.profitToman.lt(0)) {
      await dependencies.emergencyStop(`${riskStrategy}-realized-loss-circuit-breaker`).catch(() => undefined);
    }

    return NextResponse.json({
      status: result.status,
      executionId,
      signalId: candidateId(signal),
      strategy: riskStrategy,
      exitReason: result.exitReason,
      inputToman: result.inputToman.toString(),
      outputToman: result.outputToman.toString(),
      profitToman: result.profitToman.toString(),
      profitBps: result.profitBps.toString(),
      residualAssetAmount: result.residualAssetAmount.toString(),
      heldMs: result.heldMs,
      legs: result.legs.map(serializeLeg),
      pnlRecordedGlobally: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Spot position execution failed";
    const terminalAmbiguity = error instanceof SpotPositionExecutionError
      && (error.code === "ORDER_STATE_UNKNOWN" || error.code === "INVALID_PLAN" || error.code === "UNTRADABLE_RESIDUAL");
    const retryRecovery = exposed && !terminalAmbiguity;
    const manual = exposed && terminalAmbiguity;
    if (executionId !== undefined && executionState !== "CLOSED") {
      if ((manual || retryRecovery) && executionState && ["SUBMITTING", "PARTIALLY_FILLED", "HEDGING"].includes(executionState)) {
        try {
          await dependencies.transitionExecution(executionId, "RECOVERING", {
            note: retryRecovery ? "Automatic recovery is waiting for a safe retry" : "A confirmed flat USDT state could not be established",
            metadata: { error: message, retryScheduled: retryRecovery }
          });
          executionState = "RECOVERING";
        } catch { /* terminal audit below is still attempted */ }
      }
      if (!retryRecovery) {
        await dependencies.failExecution(executionId, message, { metadata: { manualInterventionRequired: manual } }).catch(() => undefined);
        executionState = "FAILED_MANUAL";
      }
    }
    if (exposed) await dependencies.emergencyStop(`spot-position-unresolved-exposure:${message}`).catch(() => undefined);
    const status = error instanceof SpotPositionExecutionError
      ? error.code === "REVALIDATION_FAILED" ? 409
        : error.code === "INVALID_PLAN" ? 400
          : error.code === "MAINNET_REQUIRED" ? 423
            : retryRecovery ? 503 : 502
      : error instanceof StrategyExecutionConflictError ? 409
        : retryRecovery ? 503 : 500;
    return NextResponse.json({
      error: message,
      code: error instanceof SpotPositionExecutionError ? error.code
        : error instanceof StrategyExecutionConflictError ? error.code : "SPOT_POSITION_EXECUTION_FAILED",
      executionId,
      existingExecutionId: error instanceof StrategyExecutionConflictError ? error.existingExecutionId : undefined,
      manualInterventionRequired: manual,
      retryScheduled: retryRecovery
    }, { status });
  } finally {
    if (lease) await dependencies.releaseLease(lease).catch(() => undefined);
    if (recordLock) await dependencies.releaseRecordLock(recordLock).catch(() => undefined);
  }
}

/**
 * Crash/restart recovery entry point. It accepts no amount or price from the
 * browser: exposure is rebuilt from persisted exchange order ids, reconciled
 * against Mainnet, and only the remaining known asset amount may be sold to USDT.
 */
export async function handleSpotPositionRecoveryRequest(
  request: Request,
  kind: SpotPositionRouteKind,
  dependencies: SpotPositionRouteDependencies = defaultSpotPositionRouteDependencies
) {
  if (!isDashboardStrategyRequest(request)) {
    return NextResponse.json({ error: "Position recovery is accepted only from this dashboard" }, { status: 403 });
  }
  const schema = z.object({ signalId: signalIdSchema(kind) }).strict();
  let input: z.infer<typeof schema>;
  try { input = schema.parse(await request.json()); } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Recovery body accepts only signalId", issues: error.issues }, { status: 400 });
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  const apiHostname = hostname(dependencies.apiBaseUrl());
  if (apiHostname !== OFFICIAL_MAINNET_HOSTNAME) {
    return NextResponse.json({ error: "Automatic persisted-position recovery requires official Mainnet", code: "MAINNET_REQUIRED" }, { status: 423 });
  }

  const riskStrategy = spotRiskStrategy(kind);
  let lease: ExecutionLease | undefined;
  let recordLock: StrategyExecutionRecordLock | undefined;
  let executionId: number | undefined;
  let executionState: StrategyExecutionState | undefined;
  try {
    const history = await dependencies.listExecutions({ strategy: riskStrategy, limit: 200 });
    const activeStates = new Set<StrategyExecutionState>(["SUBMITTING", "PARTIALLY_FILLED", "HEDGING", "RECOVERING"]);
    const record = history.records.find(candidate => candidate.signalId === input.signalId && activeStates.has(candidate.state));
    if (!record) {
      return NextResponse.json({ status: "not-found", reason: "No active persisted position exists for this signal" }, { status: 404 });
    }
    executionId = record.id;
    executionState = record.state;
    const plan = deserializeSpotPositionExecutionPlan(record.metadata.executionPlan);
    if (plan.strategy !== kind || plan.riskStrategy !== riskStrategy || plan.signalId !== input.signalId) {
      throw new SpotPositionExecutionError("Persisted plan does not match the requested recovery strategy", "INVALID_PLAN", true);
    }

    const recordLockResult = await dependencies.acquireRecordLock({
      executionId,
      owner: `spot-position:recovery:${record.id}`,
      ttlMs: 600_000
    });
    if (!recordLockResult.acquired) {
      return NextResponse.json({ status: "busy", code: "POSITION_ALREADY_OWNED" }, { status: 409 });
    }
    recordLock = recordLockResult.lock;

    const acquisition = await dependencies.acquireRecoveryLease({
      strategy: riskStrategy,
      owner: `spot-position:recovery:${record.id}:${dependencies.randomId()}`,
      ttlMs: 300_000
    });
    if (!acquisition.acquired) {
      return NextResponse.json({ status: "busy", code: "RECOVERY_BUSY", blockers: acquisition.blockers }, { status: 409 });
    }
    lease = acquisition.lease;
    const client = dependencies.createClient();
    const reconciled = await reconcilePersistedExposure(record.orders, client);
    if (executionState !== "RECOVERING") {
      await dependencies.transitionExecution(executionId, "RECOVERING", {
        note: "Persisted position reconciled after request/process interruption",
        metadata: {
          reconciledAt: dependencies.now(),
          reconciledExposureAmount: reconciled.exposureAmount.toString(),
          reconciledExchangeOrderIds: reconciled.exchangeOrderIds
        }
      });
      executionState = "RECOVERING";
    }

    if (reconciled.exposureAmount.lte(0)) {
      const profit = reconciled.outputToman.minus(reconciled.inputToman);
      await dependencies.completeExecution(executionId, {
        note: "Reconciliation proved the persisted position is already flat in USDT",
        actualOutputToman: reconciled.outputToman.toNumber(),
        actualProfitToman: profit.toNumber(),
        metadata: { recoveryResume: "already-flat", pnlRecordedGlobally: true }
      });
      executionState = "CLOSED";
      await recordPnlOrStop(dependencies, riskStrategy, executionId, profit.toNumber());
      if (profit.lt(0)) await dependencies.emergencyStop(`${riskStrategy}-recovery-realized-loss`).catch(() => undefined);
      return NextResponse.json({
        status: "already-flat",
        executionId,
        exposureAmount: "0",
        outputToman: reconciled.outputToman.toString(),
        profitToman: profit.toString(),
        pnlRecordedGlobally: true
      });
    }

    const hooks: SpotPositionExecutionHooks = {
      onBeforeOrder: async ({ quote, request: orderRequest }) => {
        if (!lease || !await dependencies.renewLease(lease, 300_000)) {
          throw new SpotPositionExecutionError("Recovery Lease ownership was lost", "ORDER_STATE_UNKNOWN", true);
        }
        await dependencies.addOrder(executionId!, {
          legIndex: 2,
          symbol: quote.edge.book.symbol,
          side: "SELL",
          status: "submitting",
          clientOrderId: orderRequest.clientOrderId,
          requestedAmount: orderRequest.amountBase.toString(),
          inputAsset: quote.edge.from,
          outputAsset: "USDT",
          raw: { event: "before-submit", stage: "recovery-resume", expectedPrice: orderRequest.expectedPrice.toString() }
        });
      },
      onOrderSubmitted: async ({ order, request: orderRequest }) => {
        await dependencies.addOrder(executionId!, {
          legIndex: 2,
          symbol: `${orderRequest.base}${orderRequest.quote}`,
          side: "SELL",
          status: order.status,
          clientOrderId: orderRequest.clientOrderId,
          exchangeOrderId: order.id,
          requestedAmount: orderRequest.amountBase.toString(),
          filledAmount: order.matchedAmount.toString(),
          averagePrice: order.averagePrice.toString(),
          fee: order.fee.toString(),
          inputAsset: plan.asset,
          outputAsset: "USDT",
          raw: { event: "submitted", stage: "recovery-resume", exchange: order.raw }
        });
      },
      onOrderFinalized: async ({ leg }) => {
        await dependencies.addOrder(executionId!, {
          legIndex: 2,
          symbol: leg.symbol,
          side: "SELL",
          status: leg.status,
          clientOrderId: leg.clientOrderId,
          exchangeOrderId: leg.orderId,
          requestedAmount: leg.submittedAmountBase.toString(),
          filledAmount: leg.matchedAmountBase.toString(),
          averagePrice: leg.averagePrice.toString(),
          fee: leg.fee.toString(),
          inputAsset: plan.asset,
          outputAsset: "USDT",
          raw: { event: "finalized", stage: "recovery-resume", fullFill: leg.fullFill, actualOutput: leg.actualOutput.toString() }
        });
      }
    };
    const recovery = await dependencies.recover(plan, reconciled.exposureAmount, client, hooks);
    const outputToman = reconciled.outputToman.plus(recovery.recoveredToman);
    const profitToman = outputToman.minus(reconciled.inputToman);
    await dependencies.completeExecution(executionId, {
      note: "Persisted exposure was flattened to USDT with a server Recovery Lease",
      actualOutputToman: outputToman.toNumber(),
      actualProfitToman: profitToman.toNumber(),
      metadata: {
        recoveryResume: "completed",
        residualAssetAmount: recovery.residualAssetAmount.toString(),
        recoveryOrderId: recovery.leg.orderId,
        pnlRecordedGlobally: true
      }
    });
    executionState = "CLOSED";
    await recordPnlOrStop(dependencies, riskStrategy, executionId, profitToman.toNumber());
    if (profitToman.lt(0)) await dependencies.emergencyStop(`${riskStrategy}-recovery-realized-loss`).catch(() => undefined);
    return NextResponse.json({
      status: "recovered",
      executionId,
      recoveredToman: recovery.recoveredToman.toString(),
      outputToman: outputToman.toString(),
      profitToman: profitToman.toString(),
      residualAssetAmount: recovery.residualAssetAmount.toString(),
      recoveryOrder: serializeLeg(recovery.leg),
      pnlRecordedGlobally: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Persisted-position recovery failed";
    const terminal = error instanceof SpotPositionExecutionError
      && (error.code === "ORDER_STATE_UNKNOWN" || error.code === "INVALID_PLAN" || error.code === "UNTRADABLE_RESIDUAL");
    if (executionId !== undefined && executionState !== "CLOSED") {
      if (executionState && executionState !== "RECOVERING" && ["SUBMITTING", "PARTIALLY_FILLED", "HEDGING"].includes(executionState)) {
        try {
          await dependencies.transitionExecution(executionId, "RECOVERING", {
            note: terminal ? "Recovery reconciliation requires manual intervention" : "Recovery is waiting for a safe retry",
            metadata: { error: message, retryScheduled: !terminal }
          });
          executionState = "RECOVERING";
        } catch { /* fail below */ }
      }
      if (terminal) {
        await dependencies.failExecution(executionId, message, { metadata: { manualInterventionRequired: true, recoveryResumeFailed: true } }).catch(() => undefined);
        executionState = "FAILED_MANUAL";
      }
    }
    // Stop new exposure while an old Position is unresolved. Recovery Lease is
    // intentionally still available and the durable supervisor retries it.
    await dependencies.emergencyStop(`spot-position-recovery-unresolved:${message}`).catch(() => undefined);
    return NextResponse.json({
      error: message,
      code: error instanceof SpotPositionExecutionError ? error.code : "RECOVERY_RECONCILIATION_FAILED",
      executionId,
      manualInterventionRequired: terminal,
      retryScheduled: !terminal
    }, { status: error instanceof SpotPositionExecutionError && error.code === "INVALID_PLAN" ? 400 : terminal ? 502 : 503 });
  } finally {
    if (lease) await dependencies.releaseLease(lease).catch(() => undefined);
    if (recordLock) await dependencies.releaseRecordLock(recordLock).catch(() => undefined);
  }
}

async function reconcilePersistedExposure(
  orders: Array<{
    side: "BUY" | "SELL";
    clientOrderId: string | null;
    exchangeOrderId: string | null;
  }>,
  client: SpotPositionExecutionClient
) {
  const exchangeByClient = new Map<string, string>();
  for (const order of orders) if (order.clientOrderId && order.exchangeOrderId) exchangeByClient.set(order.clientOrderId, order.exchangeOrderId);
  const unique = new Map<string, "BUY" | "SELL">();
  for (const order of orders) if (order.exchangeOrderId) unique.set(order.exchangeOrderId, order.side);
  const ambiguous = orders.filter(order => order.clientOrderId && !order.exchangeOrderId && !exchangeByClient.has(order.clientOrderId));
  for (const intent of ambiguous) {
    if (!client.getOrderStatusByClientOrderId) {
      throw new SpotPositionExecutionError(
        `Persisted clientOrderId ${intent.clientOrderId} has no exchange order id and lookup is unavailable; automatic SELL is blocked`,
        "ORDER_STATE_UNKNOWN",
        true
      );
    }
    let resolved;
    try { resolved = await client.getOrderStatusByClientOrderId(intent.clientOrderId!); }
    catch (error) {
      throw new SpotPositionExecutionError(
        `Persisted clientOrderId ${intent.clientOrderId} could not be reconciled; automatic SELL is blocked`,
        "ORDER_STATE_UNKNOWN",
        true,
        { cause: error }
      );
    }
    if (!resolved.id) {
      throw new SpotPositionExecutionError(`clientOrderId ${intent.clientOrderId} returned no exchange order id`, "ORDER_STATE_UNKNOWN", true);
    }
    unique.set(resolved.id, intent.side);
  }
  if (!unique.size) throw new SpotPositionExecutionError("No exchange order id exists for exposure reconciliation", "ORDER_STATE_UNKNOWN", true);

  let boughtBase = new Decimal(0);
  let soldBase = new Decimal(0);
  let inputToman = new Decimal(0);
  let outputToman = new Decimal(0);
  for (const [id, side] of unique) {
    let order;
    try { order = await client.getOrderStatus(id); } catch (error) {
      throw new SpotPositionExecutionError(`Could not reconcile exchange order ${id}`, "ORDER_STATE_UNKNOWN", true, { cause: error });
    }
    if (!isTerminalOrder(order.status)) {
      try {
        await client.cancelOrder(id);
        order = await client.getOrderStatus(id);
      } catch (error) {
        throw new SpotPositionExecutionError(`Could not cancel/reconcile exchange order ${id}`, "ORDER_STATE_UNKNOWN", true, { cause: error });
      }
    }
    if (!isTerminalOrder(order.status)) throw new SpotPositionExecutionError(`Exchange order ${id} remains non-terminal`, "ORDER_STATE_UNKNOWN", true);
    if (side === "BUY") {
      boughtBase = boughtBase.plus(Decimal.max(order.matchedAmount.minus(order.fee), 0));
      inputToman = inputToman.plus(order.totalPrice.div(10));
    } else {
      soldBase = soldBase.plus(order.matchedAmount);
      outputToman = outputToman.plus(Decimal.max(order.totalPrice.minus(order.fee).div(10), 0));
    }
  }
  return {
    exposureAmount: Decimal.max(boughtBase.minus(soldBase), 0),
    inputToman,
    outputToman,
    exchangeOrderIds: [...unique.keys()]
  };
}

export function isDashboardStrategyRequest(request: Request) {
  if (request.headers.get("x-strategy-action") !== "bitget-dashboard") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

function findExecutableSpotSignal(
  signals: SpotPositionRouteCandidate[],
  kind: SpotPositionRouteKind,
  signalId: string
) {
  return signals.find(candidate => {
    if (candidate.id !== signalId) return false;
    if (kind === "ai-autonomous") {
      return candidate.kind === "autonomous-market"
        && candidate.source === "independent-orderbook-scanner"
        && candidate.executable
        && candidate.gatePassed
        && candidate.direction === "LONG";
    }
    return candidate.kind === kind
      && candidate.status === "actionable"
      && candidate.metrics.spotExecutable === true
      && candidate.metrics.direction === "LONG";
  });
}

function hostname(url: string) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function spotRiskStrategy(kind: SpotPositionRouteKind) {
  return kind === "orderbook-gap"
    ? "gapTrading" as const
    : kind === "ai-autonomous"
      ? "aiAgent" as const
      : "imbalance" as const;
}

function signalIdSchema(kind: SpotPositionRouteKind) {
  if (kind === "orderbook-gap") return z.string().trim().min(1).max(120).regex(/^gap:[A-Z0-9_-]+USDT:ask:\d+$/i);
  if (kind === "ai-autonomous") return z.string().trim().min(1).max(100).regex(/^ai-market:[A-Z0-9_-]+USDT$/i);
  return z.string().trim().min(1).max(100).regex(/^imbalance:[A-Z0-9_-]+USDT$/i);
}

async function recordPnlOrStop(
  dependencies: Pick<SpotPositionRouteDependencies, "recordPnl" | "emergencyStop">,
  strategy: "gapTrading" | "imbalance" | "aiAgent",
  executionId: number,
  pnlToman: number
) {
  try {
    await dependencies.recordPnl(pnlToman, new Date(), {
      idempotencyKey: `spot:${executionId}:pnl`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown-risk-accounting-error";
    await dependencies.emergencyStop(`${strategy}-risk-accounting-failed:${message}`).catch(() => undefined);
    throw error;
  }
}

function withSpotCapital(
  settings: BotSettings,
  kind: SpotPositionRouteKind,
  capitalToman: number
): BotSettings {
  if (kind === "orderbook-gap") {
    return {
      ...settings,
      strategyLab: {
        ...settings.strategyLab,
        gapTrading: { ...settings.strategyLab.gapTrading, capitalToman }
      }
    };
  }
  if (kind === "ai-autonomous") {
    return {
      ...settings,
      aiAgent: { ...settings.aiAgent, maxLiveCapitalToman: capitalToman }
    };
  }
  return {
    ...settings,
    strategyLab: {
      ...settings.strategyLab,
      imbalance: { ...settings.strategyLab.imbalance, capitalToman }
    }
  };
}

function candidateId(candidate: SpotPositionRouteCandidate) {
  return candidate.id;
}

function candidateSymbols(candidate: SpotPositionRouteCandidate) {
  return candidate.kind === "autonomous-market" ? [candidate.symbol] : candidate.symbols;
}

function candidateEstimatedProfit(candidate: SpotPositionRouteCandidate) {
  return candidate.kind === "autonomous-market"
    ? new Decimal(candidate.estimatedNetProfitToman)
    : candidate.estimatedNetProfitToman;
}

function isTerminalOrder(status: string) {
  return ["done", "canceled", "cancelled", "rejected"].includes(status.toLowerCase());
}

function serializeLeg(leg: SpotPositionExecutionResult["legs"][number]) {
  return {
    ...leg,
    submittedAmountBase: leg.submittedAmountBase.toString(),
    matchedAmountBase: leg.matchedAmountBase.toString(),
    unmatchedAmountBase: leg.unmatchedAmountBase.toString(),
    actualInput: leg.actualInput.toString(),
    actualOutput: leg.actualOutput.toString(),
    fee: leg.fee.toString(),
    averagePrice: leg.averagePrice.toString()
  };
}
