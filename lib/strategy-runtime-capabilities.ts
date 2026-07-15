import type { RiskEvaluation, RiskState, RiskStrategy } from "@/lib/risk/types";

export type RuntimeEnvironmentKind = "mainnet" | "custom";
export type StrategyExecutionScope = "mainnet-only" | "unavailable";

export type StrategyRuntimeCapability = {
  scope: StrategyExecutionScope;
  automaticExecution: boolean;
  closedTomanPnl: boolean;
  executionEndpoint: string | null;
  recoveryEndpoint: string | null;
  blocker: string | null;
};

/**
 * Runtime truth used by both the dashboard and API responses. Readiness proves
 * that code, state and recovery gates exist; scope separately states where the
 * adapter is allowed to place orders. Keeping these concepts separate prevents
 * an implemented foundation from being presented outside its supported execution environment.
 */
export const STRATEGY_RUNTIME_CAPABILITIES: Readonly<Record<RiskStrategy, StrategyRuntimeCapability>> = Object.freeze({
  triangle: {
    scope: "mainnet-only",
    automaticExecution: true,
    closedTomanPnl: true,
    executionEndpoint: "/api/live/execute",
    recoveryEndpoint: null,
    blocker: null
  },
  gapTrading: {
    scope: "unavailable",
    automaticExecution: false,
    closedTomanPnl: false,
    executionEndpoint: null,
    recoveryEndpoint: null,
    blocker: "not-ported-to-bitget"
  },
  imbalance: {
    scope: "unavailable",
    automaticExecution: false,
    closedTomanPnl: false,
    executionEndpoint: null,
    recoveryEndpoint: null,
    blocker: "not-ported-to-bitget"
  },
  aiAgent: {
    scope: "unavailable",
    automaticExecution: false,
    closedTomanPnl: false,
    executionEndpoint: null,
    recoveryEndpoint: null,
    blocker: "not-ported-to-bitget"
  }
});

export function strategyEnvironmentSupported(strategy: RiskStrategy, environment: RuntimeEnvironmentKind) {
  const scope = STRATEGY_RUNTIME_CAPABILITIES[strategy].scope;
  return scope === "mainnet-only" && environment === "mainnet";
}

export function strategyRuntimeBlocker(strategy: RiskStrategy, environment: RuntimeEnvironmentKind) {
  const capability = STRATEGY_RUNTIME_CAPABILITIES[strategy];
  if (capability.scope === "unavailable") return capability.blocker ?? "runtime-execution-unavailable";
  if (!strategyEnvironmentSupported(strategy, environment)) return "runtime-environment-not-supported";
  return null;
}

export function applyRuntimeCapabilityEvaluation(
  evaluation: RiskEvaluation,
  environment: RuntimeEnvironmentKind
): RiskEvaluation {
  const strategies = { ...evaluation.strategies };
  for (const strategy of Object.keys(strategies) as RiskStrategy[]) {
    const blocker = strategyRuntimeBlocker(strategy, environment);
    if (!blocker) continue;
    const current = strategies[strategy];
    strategies[strategy] = {
      ...current,
      canExecute: false,
      blockers: [...new Set([...current.blockers, blocker])]
    };
  }
  return {
    ...evaluation,
    canExecute: (Object.keys(strategies) as RiskStrategy[]).some(strategy => strategies[strategy].canExecute),
    strategies
  };
}

export function hasRuntimeReadyStrategy(state: RiskState, environment: RuntimeEnvironmentKind) {
  return (Object.keys(state.strategies) as RiskStrategy[]).some(strategy => {
    const item = state.strategies[strategy];
    const readiness = item.readiness;
    return item.enabled
      && readiness.positionStateReady
      && readiness.recoveryReady
      && readiness.executionAdapterReady
      && !strategyRuntimeBlocker(strategy, environment);
  });
}
