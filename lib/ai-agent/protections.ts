import type { AiAgentSettings } from "./settings";
import type { AiAgentState, AiDemoTrade } from "./types";
import { AI_AUTOPILOT_PROFILES } from "./autopilot-profiles";

export type AiAutopilotProtection = {
  active: boolean;
  scope: "global" | "pair" | "none";
  blockers: string[];
  until: number | null;
  observedDrawdownPercent: number;
};

export function evaluateAiGlobalProtections(
  state: AiAgentState,
  settings: AiAgentSettings,
  now = Date.now()
): AiAutopilotProtection {
  const policy = AI_AUTOPILOT_PROFILES[settings.autopilotProfile].protection;
  const trades = eligibleTrades(state.demo.recentTrades, now).slice(0, policy.recentTradeWindow);
  const blockers: string[] = [];
  const lockEnds: number[] = [];
  const latestTradeAt = trades[0]?.closedAt;

  let consecutiveLosses = 0;
  for (const trade of trades) {
    if (trade.pnlToman >= 0) break;
    consecutiveLosses += 1;
  }
  if (latestTradeAt !== undefined && consecutiveLosses >= policy.consecutiveLossLimit) {
    const until = latestTradeAt + policy.globalPauseMs;
    if (now < until) {
      blockers.push("autopilot-loss-streak-pause");
      lockEnds.push(until);
    }
  }

  const observedDrawdownPercent = rollingDrawdownPercent(
    trades,
    state.demo.initialCapitalToman,
    state.demo.realizedPnlToman
  );
  if (latestTradeAt !== undefined && observedDrawdownPercent >= policy.maxRollingDrawdownPercent) {
    const until = latestTradeAt + policy.globalPauseMs;
    if (now < until) {
      blockers.push("autopilot-drawdown-pause");
      lockEnds.push(until);
    }
  }

  return {
    active: blockers.length > 0,
    scope: blockers.length ? "global" : "none",
    blockers,
    until: lockEnds.length ? Math.max(...lockEnds) : null,
    observedDrawdownPercent
  };
}

export function evaluateAiCandidateProtections(
  state: AiAgentState,
  settings: AiAgentSettings,
  symbol: string,
  now = Date.now()
): AiAutopilotProtection {
  const global = evaluateAiGlobalProtections(state, settings, now);
  if (global.active) return global;

  const normalizedSymbol = symbol.trim().toUpperCase();
  const policy = AI_AUTOPILOT_PROFILES[settings.autopilotProfile].protection;
  const pairTrades = eligibleTrades(state.demo.recentTrades, now)
    .filter(trade => trade.symbol.trim().toUpperCase() === normalizedSymbol)
    .slice(0, policy.pairTradeWindow);
  const blockers: string[] = [];
  const lockEnds: number[] = [];

  if (pairTrades.length >= policy.pairMinimumTrades) {
    const pairPnl = pairTrades.reduce((sum, trade) => sum + trade.pnlToman, 0);
    const until = pairTrades[0]!.closedAt + policy.pairPauseMs;
    if (pairPnl < 0 && now < until) {
      blockers.push("autopilot-low-profit-pair");
      lockEnds.push(until);
    }
  }

  const lastPairExit = pairTrades[0]?.closedAt ?? 0;
  const lastLiveExecution = state.decisions
    .filter(decision => decision.mode === "live"
      && decision.action === "executed"
      && decision.symbol?.trim().toUpperCase() === normalizedSymbol
      && decision.at <= now)
    .reduce((latest, decision) => Math.max(latest, decision.at), 0);
  const lastCompletedAt = Math.max(lastPairExit, lastLiveExecution);
  if (lastCompletedAt > 0) {
    const until = lastCompletedAt + settings.cooldownMs;
    if (now < until) {
      blockers.push("autopilot-pair-cooldown");
      lockEnds.push(until);
    }
  }

  return {
    active: blockers.length > 0,
    scope: blockers.length ? "pair" : "none",
    blockers,
    until: lockEnds.length ? Math.max(...lockEnds) : null,
    observedDrawdownPercent: global.observedDrawdownPercent
  };
}

function eligibleTrades(trades: AiDemoTrade[], now: number) {
  return trades
    .filter(trade => !trade.learningOnly && trade.closedAt <= now)
    .sort((left, right) => right.closedAt - left.closedAt);
}

function rollingDrawdownPercent(
  newestFirstTrades: AiDemoTrade[],
  initialCapitalToman: number,
  totalRealizedPnlToman: number
) {
  if (!newestFirstTrades.length || initialCapitalToman <= 0) return 0;
  const windowPnl = newestFirstTrades.reduce((sum, trade) => sum + trade.pnlToman, 0);
  let equity = Math.max(1, initialCapitalToman + totalRealizedPnlToman - windowPnl);
  let peak = equity;
  let maximumDrawdown = 0;
  for (const trade of [...newestFirstTrades].reverse()) {
    equity += trade.pnlToman;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  return maximumDrawdown / Math.max(1, peak) * 100;
}
