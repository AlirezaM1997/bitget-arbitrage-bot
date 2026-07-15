import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AI_OFFLINE_FEATURE_CONTRACT,
  readOfflineModelArtifact,
  splitOfflineDataset,
  trainOfflineCandidate,
  writeOfflineModelArtifact,
  type OfflineDatasetManifest,
  type OfflineTrainingSample
} from "@/lib/ai-agent/offline";
import { createDefaultAiAgentState, readAiAgentState } from "@/lib/ai-agent/store";
import { AI_FEATURE_NAMES, type AiFeatures } from "@/lib/ai-agent/types";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "bitget-ai-offline-"));
  process.env.AI_MODEL_ARTIFACTS_PATH = path.join(directory, "models");
  process.env.AI_AGENT_STATE_PATH = path.join(directory, "online-state.json");
});

afterEach(async () => {
  delete process.env.AI_MODEL_ARTIFACTS_PATH;
  delete process.env.AI_AGENT_STATE_PATH;
  await rm(directory, { recursive: true, force: true });
});

describe("offline candidate trainer", () => {
  test("is deterministic and carries an explicit feature contract and provenance", () => {
    const samples = sampleSeries(120, 1_000, 100);
    const manifest = datasetManifest(samples);
    const config = {
      epochs: 4,
      learningRatePercent: 3,
      decisionThreshold: 0.55,
      split: { validationFraction: 0.2, testFraction: 0.2, purgeMs: 0, embargoMs: 0 }
    };
    const first = trainOfflineCandidate({ manifest, samples, config, createdAt: 123_456 });
    const second = trainOfflineCandidate({ manifest, samples: [...samples].reverse(), config, createdAt: 123_456 });

    expect(first).toEqual(second);
    expect(first.featureContract).toEqual(AI_OFFLINE_FEATURE_CONTRACT);
    expect(first.dataset.externalSampleCount).toBe(120);
    expect(first.dataset.sourceProvider).toBe("Fixture Exchange Archive");
    expect(first.isolation).toEqual({
      currentStateMutated: false,
      currentTrainingSamplesAdded: 0,
      promotionRequired: true
    });
    expect(first.metrics.validation.samples).toBeGreaterThan(0);
    expect(first.metrics.test.accuracy).toBeGreaterThan(0.5);
    expect(first.metrics.test.brierScore).toBeGreaterThanOrEqual(0);
    expect(first.metrics.test.maxDrawdownBps).toBeGreaterThanOrEqual(0);
  });

  test("purges label overlap and embargoes observations after each time boundary", () => {
    const samples = sampleSeries(90, 1_000, 2_500);
    const config = {
      validationFraction: 0.2,
      testFraction: 0.2,
      purgeMs: 500,
      embargoMs: 2_000
    };
    const split = splitOfflineDataset(samples, config);

    expect(split.train.every(sample =>
      sample.outcomeAt < split.boundaries.validationBoundaryAt - config.purgeMs
    )).toBe(true);
    expect(split.validation.every(sample =>
      sample.observedAt >= split.boundaries.validationBoundaryAt + config.embargoMs
      && sample.outcomeAt < split.boundaries.testBoundaryAt - config.purgeMs
    )).toBe(true);
    expect(split.test.every(sample =>
      sample.observedAt >= split.boundaries.testBoundaryAt + config.embargoMs
    )).toBe(true);
    expect(split.excluded.purged).toBeGreaterThan(0);
    expect(split.excluded.embargoed).toBeGreaterThan(0);
  });

  test("keeps external observations separate from online readiness counters", async () => {
    const initial = await readAiAgentState(1_000_000);
    expect(initial).toEqual(createDefaultAiAgentState(1_000_000, initial.updatedAt));
    const samples = sampleSeries(60, 1_000, 100);
    const artifact = trainOfflineCandidate({
      manifest: datasetManifest(samples),
      samples,
      config: { split: { validationFraction: 0.2, testFraction: 0.2, purgeMs: 0, embargoMs: 0 } },
      createdAt: 500
    });

    const onlineAfterTraining = await readAiAgentState(1_000_000);
    expect(onlineAfterTraining.model.trainingSamples).toBe(0);
    expect(onlineAfterTraining.model.modelVersion).toBe(1);
    expect(artifact.dataset.externalSampleCount).toBe(60);
    expect(artifact.isolation.currentTrainingSamplesAdded).toBe(0);
  });
});

describe("immutable offline artifact store", () => {
  test("detects checksum tampering and refuses to overwrite an artifact id", async () => {
    const samples = sampleSeries(60, 1_000, 100);
    const artifact = trainOfflineCandidate({
      manifest: datasetManifest(samples),
      samples,
      config: { split: { validationFraction: 0.2, testFraction: 0.2, purgeMs: 0, embargoMs: 0 } },
      createdAt: 700
    });
    const filename = await writeOfflineModelArtifact(artifact);
    expect((await readOfflineModelArtifact(artifact.artifactId)).checksum.value).toBe(artifact.checksum.value);
    await expect(writeOfflineModelArtifact(artifact)).rejects.toThrow("already exists");

    const tampered = JSON.parse(await readFile(filename, "utf8"));
    tampered.model.bias += 0.1;
    await writeFile(filename, JSON.stringify(tampered));
    await expect(readOfflineModelArtifact(artifact.artifactId)).rejects.toThrow("checksum mismatch");
  });
});

function sampleSeries(count: number, spacingMs: number, horizonMs: number): OfflineTrainingSample[] {
  return Array.from({ length: count }, (_, index) => {
    const positive = index % 4 !== 0;
    const direction = positive ? 1 : -1;
    return {
      id: `sample-${String(index).padStart(4, "0")}`,
      observedAt: index * spacingMs,
      outcomeAt: index * spacingMs + horizonMs,
      sequence: index,
      features: features(direction, index),
      label: positive ? 1 : 0,
      netPnlBps: positive ? 80 : -120
    };
  });
}

function datasetManifest(samples: OfflineTrainingSample[]): OfflineDatasetManifest {
  return {
    schemaVersion: 1,
    datasetId: "fixture-l2-v1",
    createdAt: 100,
    source: {
      provider: "Fixture Exchange Archive",
      dataset: "L2 order book fixture",
      url: "https://example.com/datasets/l2",
      license: "Test-only",
      retrievedAt: 100,
      contentSha256: "a".repeat(64)
    },
    market: {
      venue: "Fixture",
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      marketType: "spot"
    },
    coverage: {
      startAt: samples[0]!.observedAt,
      endAt: samples.at(-1)!.observedAt,
      recordCount: samples.length
    },
    labels: {
      horizonMs: samples[0]!.outcomeAt - samples[0]!.observedAt,
      policy: "Positive when executable future exit is profitable after all costs",
      executableCostsIncluded: true
    },
    featureContract: { ...AI_OFFLINE_FEATURE_CONTRACT }
  };
}

function features(direction: number, index: number): AiFeatures {
  const base = Object.fromEntries(AI_FEATURE_NAMES.map(name => [name, 0])) as AiFeatures;
  return {
    ...base,
    expectedEdge: direction * 1.5,
    confidence: direction > 0 ? 0.8 : 0.2,
    orderFlow: direction * 0.7,
    microprice: direction * 0.4,
    retention: direction > 0 ? 0.75 : 0.25,
    spread: 0.2 + (index % 3) * 0.01,
    impact: 0.1,
    roundTripCost: 0.3,
    persistence: 0.5,
    kind: index % 2 === 0 ? 1 : -1
  };
}
