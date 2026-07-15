import { describe, expect, test } from "bun:test";
import { defaultBotSettings } from "@/lib/bot-settings";
import {
  handleAiTrainingPost,
  type AiTrainingRouteDependencies
} from "@/app/api/ai-agent/training/route";
import type { OfflineModelArtifact } from "@/lib/ai-agent/offline";

function request(
  body: unknown = { symbol: "BTCUSDT", date: "2025-01-01", minutes: 3 },
  origin = "http://localhost:3000",
  action = "train-tardis-sample"
) {
  return new Request("http://localhost:3000/api/ai-agent/training", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      host: "localhost:3000",
      "x-ai-training-action": action
    },
    body: JSON.stringify(body)
  });
}

function dependencies(mode: "demo" | "live" = "demo") {
  const calls: unknown[] = [];
  const artifact = {
    artifactId: "fixture-candidate",
    createdAt: 2,
    status: "candidate"
  } as OfflineModelArtifact;
  const value: AiTrainingRouteDependencies = {
    getSettings: async () => ({
      ...defaultBotSettings,
      aiAgent: { ...defaultBotSettings.aiAgent, enabled: true, mode }
    }),
    listArtifactIds: async () => [artifact.artifactId],
    readArtifact: async () => artifact,
    trainCandidate: async (trainingRequest, economics) => {
      calls.push({ trainingRequest, economics });
      return {
        artifact,
        dataset: {
          manifest: { datasetId: "fixture" },
          samples: [{ id: "one" }],
          replay: { downloadedMinutes: 3 }
        }
      } as never;
    },
    now: (() => {
      let now = 10;
      return () => now++;
    })(),
    id: () => "job-1"
  };
  return { calls, value };
}

describe("AI external training API", () => {
  test("rejects foreign requests and arbitrary body fields before any download", async () => {
    const mocked = dependencies();
    expect((await handleAiTrainingPost(request(undefined, "https://attacker.example"), mocked.value)).status).toBe(403);
    const extraUrl = await handleAiTrainingPost(request({
      symbol: "BTCUSDT",
      date: "2025-01-01",
      minutes: 3,
      url: "https://attacker.example/data"
    }), mocked.value);
    expect(extraUrl.status).toBe(400);
    expect(mocked.calls).toEqual([]);
  });

  test("does not train while the AI agent is in Live mode", async () => {
    const mocked = dependencies("live");
    const response = await handleAiTrainingPost(request(), mocked.value);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AI_LIVE_TRAINING_BLOCKED" });
    expect(mocked.calls).toEqual([]);
  });

  test("uses server-side economics and returns an immutable Candidate record", async () => {
    const mocked = dependencies("demo");
    const response = await handleAiTrainingPost(request(), mocked.value);
    const json = await response.json();
    expect(response.status).toBe(201);
    expect(mocked.calls).toHaveLength(1);
    expect(mocked.calls[0]).toMatchObject({
      trainingRequest: {
        symbol: "BTCUSDT",
        date: "2025-01-01",
        minutes: 3,
        sampleIntervalMs: 1_000,
        horizonMs: 5_000
      },
      economics: {
        capitalToman: defaultBotSettings.aiAgent.demoTradeCapitalToman,
        tomanTakerFeeBps: defaultBotSettings.tomanTakerFeeBps,
        slippageBps: defaultBotSettings.slippageBufferBps
      }
    });
    expect(json.running).toBe(false);
    expect(json.artifact).toMatchObject({ artifactId: "fixture-candidate", status: "candidate" });
    expect(json.job).toMatchObject({ id: "job-1", status: "completed", artifactId: "fixture-candidate" });
  });
});
