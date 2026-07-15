import { createHash } from "node:crypto";
import { AI_FEATURE_NAMES } from "../types";

/**
 * Offline artifacts are only compatible with this exact feature contract.
 * The hash covers ordering, bounds and the scaling semantics used by the
 * current online feature extractor, so a candidate cannot be silently loaded
 * after the meaning of a feature changes.
 */
export const AI_OFFLINE_FEATURE_CONTRACT_ID = "bitget-autonomous-lob-features-v2" as const;

export const AI_OFFLINE_FEATURE_CONTRACT_SPEC = Object.freeze({
  id: AI_OFFLINE_FEATURE_CONTRACT_ID,
  producer: "measureIndependentAiBook@1",
  orderedFeatures: [...AI_FEATURE_NAMES],
  featureBounds: [-5, 5] as const,
  modelBounds: {
    linear: [-30, 30] as const,
    weight: [-8, 8] as const,
    bias: [-8, 8] as const
  },
  transforms: {
    expectedEdge: "expectedEdgeBps/100",
    confidence: "confidencePercent/100",
    orderFlow: "snapshotOrderFlow",
    microprice: "micropriceBiasBps/10",
    retention: "liquidityRetentionPercent/100",
    spread: "spreadBps/100",
    impact: "maxPriceImpactBps/100",
    roundTripCost: "roundTripCostBps/100",
    persistence: "persistenceMs/10000",
    kind: "autonomous-market=0; legacy engine labels are rejected"
  }
});

export const AI_OFFLINE_FEATURE_CONTRACT_HASH = sha256Canonical(AI_OFFLINE_FEATURE_CONTRACT_SPEC);

export const AI_OFFLINE_FEATURE_CONTRACT = Object.freeze({
  id: AI_OFFLINE_FEATURE_CONTRACT_ID,
  sha256: AI_OFFLINE_FEATURE_CONTRACT_HASH
});

export function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}
