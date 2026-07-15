import Decimal from "decimal.js";
import { quoteEdge } from "@/lib/bot/engine";
import type { BotSettings } from "@/lib/bot-settings";
import type { OrderBook } from "@/lib/exchanges/types";
import type { IndependentAiMarketCandidate } from "./market-scanner";
import {
  appendAiDecision,
  mutateAiAgentState
} from "./store";
import { predictAiProbability, updateAiModel } from "./model";
import type {
  AiAgentState,
  AiDemoPosition,
  AiDemoTrade
} from "./types";
import {
  evaluateAiCandidateProtections,
  evaluateAiGlobalProtections
} from "./protections";
import { recommendAiCapitalToman } from "./autopilot-profiles";

const BPS = 10_000;
const MAX_DEMO_TRADES = 200;
const MODEL_WARMUP_TRADES = 20;
const SHADOW_MIN_CAPITAL_TOMAN = 50_000;
const SHADOW_BLOCKERS = new Set(["edge-below-threshold"]);

export type AiDemoCycleResult = {
  opened: number;
  closed: number;
  marked: number;
  candidateCount: number;
  detail: string;
};

/**
 * Runs one deterministic virtual-broker cycle. It never owns a Bitget client,
 * execution lease or authenticated route, so a Demo tick cannot place an order.
 */
export async function runAiDemoCycle(input: {
  books: OrderBook[];
  candidates: IndependentAiMarketCandidate[];
  settings: BotSettings;
  now?: number;
}): Promise<AiDemoCycleResult> {
  const now = input.now ?? Date.now();
  const ai = input.settings.aiAgent;
  const books = new Map(input.books.map(book => [book.symbol.toUpperCase(), book]));
  const executable = input.candidates.filter(candidate => candidate.executable);
  const eligible = executable.filter(candidate => candidate.gatePassed);
  let result: AiDemoCycleResult = {
    opened: 0,
    closed: 0,
    marked: 0,
    candidateCount: eligible.length,
    detail: "demo-cycle-complete"
  };

  await mutateAiAgentState(ai.demoCapitalToman, state => {
    const stillOpen: AiDemoPosition[] = [];
    for (const position of state.demo.openPositions) {
      const book = books.get(position.symbol.toUpperCase());
      const exit = book
        ? quote("SELL", book, position.assetAmount, input.settings.tomanTakerFeeBps,
            input.settings.slippageBufferBps, input.settings.orderbookDepthUsagePercent)
        : undefined;
      if (!exit) {
        stillOpen.push(position);
        continue;
      }

      const outputToman = exit.output.toNumber();
      position.lastMarkedOutputToman = outputToman;
      result.marked += 1;
      const pnlToman = outputToman - position.inputToman;
      const pnlBps = position.inputToman > 0 ? pnlToman / position.inputToman * BPS : 0;
      const ageMs = Math.max(0, now - position.openedAt);
      const exitReason = pnlBps >= ai.takeProfitBps
        ? "take-profit"
        : pnlBps <= -ai.stopLossBps
          ? "stop-loss"
          : ageMs >= ai.maxHoldMs
            ? "max-hold"
            : undefined;
      if (!exitReason) {
        stillOpen.push(position);
        continue;
      }

      if (!position.learningOnly) {
        state.demo.cashToman += outputToman;
        state.demo.realizedPnlToman += pnlToman;
      }
      const trade: AiDemoTrade = {
        id: position.id,
        signalId: position.signalId,
        kind: position.kind,
        symbol: position.symbol,
        openedAt: position.openedAt,
        closedAt: now,
        inputToman: position.inputToman,
        outputToman,
        pnlToman,
        pnlBps,
        exitReason,
        predictionProbability: position.predictionProbability,
        features: position.features,
        modelVersion: position.modelVersion,
        learningOnly: position.learningOnly
      };
      state.demo.recentTrades = [trade, ...state.demo.recentTrades].slice(0, MAX_DEMO_TRADES);
      state.model = updateAiModel(
        state.model,
        position.features,
        position.predictionProbability,
        pnlToman > 0 ? 1 : 0,
        ai.learningRatePercent,
        pnlBps
      );
      result.closed += 1;
    }
    state.demo.openPositions = stillOpen;

    markPortfolio(state);
    const lastEntryAt = state.demo.lastEntryAt;
    const hasPortfolioPosition = state.demo.openPositions.some(position => !position.learningOnly);
    const hasLearningPosition = state.demo.openPositions.some(position => position.learningOnly);
    if (hasPortfolioPosition
      || (lastEntryAt !== null && now - lastEntryAt < ai.cooldownMs)) {
      result.detail = hasPortfolioPosition ? "demo-position-open" : "demo-cooldown";
      return state;
    }

    const globalProtection = evaluateAiGlobalProtections(state, ai, now);
    if (globalProtection.active) {
      result.detail = globalProtection.blockers[0] ?? "demo-protection-active";
      return state;
    }

    const rank = (candidate: IndependentAiMarketCandidate) => {
      const features = candidate.features;
      const probability = predictAiProbability(state.model, features);
      return {
        candidate,
        features,
        probability,
        score: probability + clamp(candidate.confidencePercent / 500, 0, 0.2)
          + clamp(candidate.expectedEdgeBps / 2_000, -0.1, 0.1)
      };
    };
    const ranked = eligible
      .filter(candidate => !evaluateAiCandidateProtections(state, ai, candidate.symbol, now).active)
      .map(rank)
      .filter(candidate => state.model.trainingSamples < MODEL_WARMUP_TRADES || candidate.probability >= 0.5)
      .sort((left, right) => right.score - left.score);
    let candidate = ranked[0];
    let learningOnly = false;
    if (!candidate && !hasLearningPosition) {
      candidate = executable
        .filter(item => !item.gatePassed
          && (item.blockers?.length ?? 0) > 0
          && item.blockers!.every(blocker => SHADOW_BLOCKERS.has(blocker)))
        .filter(item => !evaluateAiCandidateProtections(state, ai, item.symbol, now).active)
        .map(rank)
        .sort((left, right) => right.score - left.score)[0];
      learningOnly = Boolean(candidate);
    }
    if (!candidate) {
      result.detail = hasLearningPosition
        ? "demo-shadow-position-open"
        : eligible.length
          ? "model-filtered-candidates"
          : "no-demo-candidate";
      return state;
    }

    const book = books.get(candidate.candidate.symbol.toUpperCase());
    const capitalToman = learningOnly
      ? Math.min(
          ai.demoTradeCapitalToman,
          Math.max(SHADOW_MIN_CAPITAL_TOMAN, ai.demoTradeCapitalToman * 0.2)
        )
      : Math.min(
          state.demo.cashToman,
          recommendAiCapitalToman({
            maximumToman: ai.demoTradeCapitalToman,
            probability: candidate.probability,
            minimumConfidencePercent: 50,
            profile: ai.autopilotProfile
          })
        );
    const entry = book && capitalToman > 0
      ? quote("BUY", book, capitalToman, input.settings.tomanTakerFeeBps,
          input.settings.slippageBufferBps, input.settings.orderbookDepthUsagePercent)
      : undefined;
    if (!book || !entry
      || entry.spreadBps.gt(input.settings.maxSpreadBps)
      || entry.priceImpactBps.gt(input.settings.maxPriceImpactBps)) {
      result.detail = "demo-entry-depth-rejected";
      return state;
    }

    const id = `demo:${now}:${candidate.candidate.id}`;
    const immediateExit = quote(
      "SELL",
      book,
      entry.output,
      input.settings.tomanTakerFeeBps,
      input.settings.slippageBufferBps,
      input.settings.orderbookDepthUsagePercent
    );
    if (!learningOnly) state.demo.cashToman -= capitalToman;
    if (!learningOnly) state.demo.lastEntryAt = now;
    state.demo.openPositions.push({
      id,
      signalId: candidate.candidate.id,
      kind: candidate.candidate.kind,
      symbol: book.symbol,
      openedAt: now,
      inputToman: capitalToman,
      assetAmount: entry.output.toNumber(),
      entryAveragePrice: entry.averagePrice.toNumber(),
      lastMarkedOutputToman: immediateExit?.output.toNumber() ?? capitalToman,
      predictionProbability: candidate.probability,
      features: candidate.features,
      modelVersion: state.model.modelVersion,
      learningOnly
    });
    appendAiDecision(state, {
      id: `demo-open:${id}`,
      at: now,
      mode: "demo",
      action: learningOnly ? "shadow-opened" : "opened",
      kind: candidate.candidate.kind,
      symbol: book.symbol,
      probability: candidate.probability,
      detail: `${learningOnly ? "shadow" : "virtual"}-capital=${capitalToman.toFixed(2)}`
    });
    markPortfolio(state);
    result.opened += 1;
    result.detail = learningOnly ? "demo-shadow-position-opened" : "demo-position-opened";
    return state;
  });

  return result;
}

function quote(
  side: "BUY" | "SELL",
  book: OrderBook,
  input: Decimal.Value,
  feeBps: number,
  slippageBps: number,
  depthUsagePercent: number
) {
  return quoteEdge({
    id: `${book.symbol}:${side}`,
    from: side === "BUY" ? book.quote : book.base,
    to: side === "BUY" ? book.base : book.quote,
    side,
    book
  }, input, feeBps, slippageBps, depthUsagePercent);
}

function markPortfolio(state: AiAgentState) {
  const equity = state.demo.cashToman
    + state.demo.openPositions.reduce(
      (sum, position) => sum + (position.learningOnly ? 0 : position.lastMarkedOutputToman),
      0
    );
  state.demo.peakEquityToman = Math.max(state.demo.peakEquityToman, equity);
  state.demo.maxDrawdownToman = Math.max(
    state.demo.maxDrawdownToman,
    Math.max(0, state.demo.peakEquityToman - equity)
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
