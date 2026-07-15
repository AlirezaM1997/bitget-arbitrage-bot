import type { AiAgentSettings } from "./settings";
import { predictAiProbability } from "./model";
import { appendAiDecision, mutateAiAgentState, readAiAgentState } from "./store";
import type { AiAgentState, AiFeatures } from "./types";
import type { IndependentAiMarketCandidate } from "./market-scanner";
import {
  evaluateAiCandidateProtections,
  evaluateAiGlobalProtections
} from "./protections";

export type AiLiveSelection = {
  candidate: IndependentAiMarketCandidate;
  probability: number;
  features: AiFeatures;
};

/**
 * Only locally observed Bitget Demo outcomes contribute to these gates.
 * Candidate/Shadow artifacts trained on external venues deliberately do not.
 */
export function aiModelReadinessBlockers(
  state: AiAgentState,
  settings: AiAgentSettings,
  now = Date.now()
) {
  const blockers: string[] = [];
  if (!settings.enabled) blockers.push("agent-disabled");
  if (settings.mode !== "live") blockers.push("demo-mode");
  if (state.model.trainingSamples < settings.minTrainingSamples) {
    blockers.push("insufficient-training-samples");
  }
  const accuracy = state.model.trainingSamples > 0
    ? state.model.correctPredictions / state.model.trainingSamples * 100
    : 0;
  if (accuracy < settings.minPredictionAccuracyPercent) {
    blockers.push("prediction-accuracy-below-threshold");
  }
  if (state.demo.realizedPnlToman <= 0) blockers.push("demo-not-profitable");
  blockers.push(...evaluateAiGlobalProtections(state, settings, now).blockers);
  return [...new Set(blockers)];
}

/** Selects a server-discovered ID; capital and prices must be rebuilt by the execution route. */
export async function selectAiLiveCandidate(input: {
  candidates: IndependentAiMarketCandidate[];
  settings: AiAgentSettings;
  now?: number;
}) {
  const state = await readAiAgentState(input.settings.demoCapitalToman);
  const now = input.now ?? Date.now();
  const blockers = aiModelReadinessBlockers(state, input.settings, now);
  if (blockers.length) return { selection: undefined, blockers };

  const protectedReasons = new Set<string>();
  const candidates = input.candidates
    .filter(candidate => candidate.gatePassed && candidate.executable)
    .filter(candidate => candidate.quote === "USDT" && candidate.direction === "LONG")
    .filter(candidate => candidate.capitalToman <= input.settings.maxLiveCapitalToman)
    .filter(candidate => {
      const protection = evaluateAiCandidateProtections(state, input.settings, candidate.symbol, now);
      protection.blockers.forEach(blocker => protectedReasons.add(blocker));
      return !protection.active;
    })
    .map(candidate => {
      const features = candidate.features;
      const probability = predictAiProbability(state.model, features);
      return { candidate, features, probability };
    })
    .filter(candidate => candidate.probability * 100 >= input.settings.minLiveConfidencePercent)
    .sort((left, right) => {
      if (right.probability !== left.probability) return right.probability - left.probability;
      return right.candidate.estimatedNetProfitToman - left.candidate.estimatedNetProfitToman;
    });
  return {
    selection: candidates[0] as AiLiveSelection | undefined,
    blockers: candidates.length
      ? []
      : protectedReasons.size
        ? [...protectedReasons]
        : ["no-qualified-live-candidate"]
  };
}

export async function recordAiLiveDecision(input: {
  settings: AiAgentSettings;
  action: string;
  at?: number;
  candidate?: IndependentAiMarketCandidate;
  probability?: number;
  detail?: string;
}) {
  if (!input.candidate) return;
  const at = input.at ?? Date.now();
  await mutateAiAgentState(input.settings.demoCapitalToman, state => {
    appendAiDecision(state, {
      id: `live:${at}:${input.candidate?.id ?? input.action}`,
      at,
      mode: "live",
      action: input.action,
      kind: input.candidate!.kind,
      symbol: input.candidate!.symbol,
      probability: input.probability,
      detail: input.detail ?? input.action
    });
    return state;
  });
}

// Kept as a source-compatible name while callers migrate to independent candidates.
export const selectAiLiveSignal = selectAiLiveCandidate;
