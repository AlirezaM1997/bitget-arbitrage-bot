import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ExternalDatasetError,
  buildTardisOfflineDataset,
  buildTardisMinuteUrl,
  fetchTardisBinanceReplay,
  parseTardisTrainingRequest,
  trainTardisCandidate,
  type TardisTrainingRequest
} from "@/lib/ai-agent/datasets";

const request: TardisTrainingRequest = {
  symbol: "BTCUSDT",
  date: "2025-01-01",
  minutes: 3,
  sampleIntervalMs: 1_000,
  horizonMs: 5_000
};

const economics = {
  capitalToman: 100_000,
  tomanTakerFeeBps: 25,
  slippageBps: 10,
  depthUsagePercent: 40,
  levels: 3,
  levelWeightDecayPercent: 70
};

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "bitget-tardis-training-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Tardis free-sample policy", () => {
  test("accepts only allowlisted symbols, first-of-month dates and bounded minute windows", () => {
    expect(parseTardisTrainingRequest({ symbol: "BTCUSDT", date: "2025-01-01", minutes: 3 })).toEqual(request);
    expect(() => parseTardisTrainingRequest({ symbol: "DOGEUSDT", date: "2025-01-01", minutes: 3 })).toThrow();
    expect(() => parseTardisTrainingRequest({ symbol: "BTCUSDT", date: "2025-01-02", minutes: 3 })).toThrow();
    expect(() => parseTardisTrainingRequest({ symbol: "BTCUSDT", date: "2025-01-01", minutes: 16 })).toThrow();
    expect(() => parseTardisTrainingRequest({
      symbol: "BTCUSDT",
      date: "2025-01-01",
      minutes: 3,
      url: "https://attacker.example/data"
    })).toThrow();
  });

  test("constructs an immutable HTTPS API target rather than accepting a URL", () => {
    const url = buildTardisMinuteUrl(request, 2);
    expect(url.origin).toBe("https://api.tardis.dev");
    expect(url.pathname).toBe("/v1/data-feeds/binance");
    expect(url.searchParams.get("from")).toBe("2025-01-01");
    expect(url.searchParams.get("offset")).toBe("2");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
      { channel: "depth", symbols: ["btcusdt"] },
      { channel: "depthSnapshot", symbols: ["btcusdt"] }
    ]);
    expect(() => buildTardisMinuteUrl(request, 3)).toThrow();
  });
});

describe("Tardis Binance L2 reconstruction and candidate training", () => {
  test("reconstructs sequence-checked books and creates cost-adjusted independent features", async () => {
    const calls: URL[] = [];
    const replay = await fetchTardisBinanceReplay(request, {
      fetchImpl: fixtureFetch(calls),
      quoteScaleTomanPerUsdt: 100_000
    });
    expect(calls).toHaveLength(3);
    expect(calls.every(url => url.origin === "https://api.tardis.dev")).toBe(true);
    expect(replay.stats.generatedSnapshots).toBe(1);
    expect(replay.stats.depthUpdates).toBeGreaterThan(170);
    expect(replay.snapshots.length).toBeGreaterThan(170);
    expect(replay.snapshots[0]!.book.quote).toBe("USDT");
    expect(replay.snapshots[0]!.book.symbol).toBe("BTCUSDT");

    const dataset = await buildTardisOfflineDataset(request, economics, {
      fetchImpl: fixtureFetch([]),
      now: 1_800_000_000_000
    });
    expect(dataset.samples.length).toBeGreaterThan(150);
    expect(dataset.manifest.source.provider).toBe("Tardis.dev");
    expect(dataset.manifest.market).toMatchObject({ venue: "Binance Spot via Tardis.dev", symbol: "BTCUSDT" });
    expect(dataset.manifest.labels.executableCostsIncluded).toBe(true);
    expect(dataset.samples.every(sample => sample.features.kind === 0)).toBe(true);
    // A flat 99/100 book cannot overcome spread + two fees + two slippage buffers.
    expect(dataset.samples.every(sample => sample.netPnlBps < 0 && sample.label === 0)).toBe(true);
  });

  test("fails closed on an incremental-depth sequence gap", async () => {
    const fetchImpl = async () => new Response([
      line(500, snapshot(100)),
      line(1_500, depth(102, 102, "101"))
    ].join("\n") + "\n", { status: 200 });
    await expect(fetchTardisBinanceReplay(request, { fetchImpl })).rejects.toMatchObject({
      code: "TARDIS_SEQUENCE_GAP"
    } satisfies Partial<ExternalDatasetError>);
  });

  test("writes an immutable Candidate artifact without an activation path", async () => {
    const result = await trainTardisCandidate(request, economics, {
      fetchImpl: fixtureFetch([]),
      artifactDirectory: directory,
      now: 1_800_000_000_000
    });
    expect(result.artifact.status).toBe("candidate");
    expect(result.artifact.isolation).toEqual({
      currentStateMutated: false,
      currentTrainingSamplesAdded: 0,
      promotionRequired: true
    });
    expect(result.artifact.dataset.externalSampleCount).toBe(result.dataset.samples.length);
    await expect(trainTardisCandidate(request, economics, {
      fetchImpl: fixtureFetch([]),
      artifactDirectory: directory,
      now: 1_800_000_000_000
    })).rejects.toThrow("already exists");
  });
});

function fixtureFetch(calls: URL[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ "accept-encoding": "gzip" });
    const offset = Number(url.searchParams.get("offset"));
    return new Response(minuteFixture(offset), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    });
  };
}

function minuteFixture(offset: number) {
  const lines: string[] = [];
  if (offset === 0) {
    // An already-covered update before REST snapshot exercises Binance replay buffering.
    lines.push(line(100, depth(99, 100, "99")));
    lines.push(line(500, snapshot(100)));
  }
  const firstSecond = offset * 60 + (offset === 0 ? 1 : 0);
  const finalSecond = (offset + 1) * 60 - 1;
  for (let second = firstSecond; second <= finalSecond; second += 1) {
    const updateId = 100 + second;
    lines.push(line(second * 1_000 + 600, depth(updateId, updateId, second % 2 ? "101" : "100")));
  }
  return `${lines.join("\n")}\n`;
}

function line(offsetMs: number, message: unknown) {
  const at = Date.parse("2025-01-01T00:00:00.000Z") + offsetMs;
  return `${new Date(at).toISOString()} ${JSON.stringify(message)}`;
}

function snapshot(lastUpdateId: number) {
  return {
    stream: "btcusdt@depthSnapshot",
    generated: true,
    data: {
      lastUpdateId,
      bids: [["99", "100"], ["98", "100"], ["97", "100"]],
      asks: [["100", "100"], ["101", "100"], ["102", "100"]]
    }
  };
}

function depth(firstUpdateId: number, finalUpdateId: number, amount: string) {
  return {
    stream: "btcusdt@depth@100ms",
    data: {
      e: "depthUpdate",
      E: 1_735_689_600_000,
      s: "BTCUSDT",
      U: firstUpdateId,
      u: finalUpdateId,
      b: [["99", amount]],
      a: [["100", "100"]]
    }
  };
}
