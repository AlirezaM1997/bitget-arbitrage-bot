import type { StrategyLabScanResult, StrategySignal } from "./types";

export function serializeStrategySignal(signal: StrategySignal) {
  return {
    ...signal,
    expectedEdgeBps: signal.expectedEdgeBps.toString(),
    estimatedNetProfitToman: signal.estimatedNetProfitToman.toString(),
    confidence: signal.confidence.toString()
  };
}

export function serializeStrategyLab(result: StrategyLabScanResult) {
  return { ...result, signals: result.signals.map(serializeStrategySignal) };
}
