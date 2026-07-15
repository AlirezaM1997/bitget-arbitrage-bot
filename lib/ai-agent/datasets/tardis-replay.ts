import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { Level, OrderBook } from "@/lib/exchanges/types";
import {
  TARDIS_MAX_LINE_BYTES,
  TARDIS_MAX_MESSAGES_PER_MINUTE,
  TARDIS_MAX_MINUTE_BYTES,
  TARDIS_MAX_TOTAL_BYTES,
  TARDIS_REQUEST_TIMEOUT_MS,
  buildTardisMinuteUrl
} from "./policy";
import type {
  TardisBinanceAllowedSymbol,
  TardisReplayResult,
  TardisReplaySnapshot,
  TardisTrainingRequest
} from "./types";

const STORED_LEVELS_PER_SIDE = 100;
const MAX_INTERNAL_LEVELS_PER_SIDE = 10_000;
const MAX_PENDING_DEPTH_EVENTS = 5_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FetchTardisReplayOptions = {
  fetchImpl?: FetchLike;
  quoteScaleTomanPerUsdt?: number;
  timeoutMs?: number;
};

type ParsedDepthUpdate = {
  kind: "depth";
  observedAt: number;
  firstUpdateId: number;
  finalUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
};

type ParsedDepthSnapshot = {
  kind: "snapshot";
  observedAt: number;
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
};

type ParsedMessage = ParsedDepthUpdate | ParsedDepthSnapshot;

export class ExternalDatasetError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 422,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ExternalDatasetError";
  }
}

/**
 * Downloads a very small, fixed Tardis replay window and reconstructs Binance
 * Spot L2 causally. It never accepts a caller-supplied URL or channel.
 */
export async function fetchTardisBinanceReplay(
  request: TardisTrainingRequest,
  options: FetchTardisReplayOptions = {}
): Promise<TardisReplayResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const scale = positiveDecimal(options.quoteScaleTomanPerUsdt ?? 100_000, "quoteScaleTomanPerUsdt");
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? TARDIS_REQUEST_TIMEOUT_MS, "timeoutMs");
  const replayer = new BinanceSpotBookReplayer(request, scale);
  const contentHash = createHash("sha256");
  const sourceUrls: string[] = [];
  let downloadedBytes = 0;
  let parsedMessages = 0;
  let depthUpdates = 0;
  let generatedSnapshots = 0;

  for (let offset = 0; offset < request.minutes; offset += 1) {
    const url = buildTardisMinuteUrl(request, offset);
    sourceUrls.push(url.toString());
    contentHash.update(`minute:${offset}\n`, "utf8");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/x-ndjson, application/json;q=0.9, text/plain;q=0.8",
          "accept-encoding": "gzip"
        },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      clearTimeout(timer);
      throw new ExternalDatasetError(
        timedOut ? `Tardis minute ${offset} timed out` : `Tardis minute ${offset} could not be downloaded`,
        timedOut ? "TARDIS_TIMEOUT" : "TARDIS_NETWORK_ERROR",
        502,
        { cause: error }
      );
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw new ExternalDatasetError(
        `Tardis rejected minute ${offset} with HTTP ${response.status}`,
        response.status === 401 || response.status === 403 ? "TARDIS_ENTITLEMENT_REQUIRED" : "TARDIS_HTTP_ERROR",
        response.status === 429 ? 429 : 502
      );
    }
    if (!response.body) {
      clearTimeout(timer);
      throw new ExternalDatasetError(`Tardis minute ${offset} returned no response stream`, "TARDIS_EMPTY_RESPONSE", 502);
    }

    let minute: { bytes: number; messages: number };
    try {
      minute = await consumeNdjsonMinute(response.body, offset, async (line, lineBytes) => {
        parsedMessages += 1;
        if (parsedMessages > request.minutes * TARDIS_MAX_MESSAGES_PER_MINUTE) {
          throw new ExternalDatasetError("Tardis replay exceeds the approved message count", "TARDIS_MESSAGE_LIMIT");
        }
        const parsed = parseTardisLine(line, request.symbol);
        if (parsed.kind === "depth") depthUpdates += 1;
        else generatedSnapshots += 1;
        replayer.ingest(parsed);
        // Length-prefixing makes concatenated raw lines unambiguous in the provenance hash.
        contentHash.update(`${lineBytes}:`, "utf8");
        contentHash.update(line, "utf8");
        contentHash.update("\n", "utf8");
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ExternalDatasetError(`Tardis minute ${offset} timed out`, "TARDIS_TIMEOUT", 502, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    downloadedBytes += minute.bytes;
    if (downloadedBytes > TARDIS_MAX_TOTAL_BYTES) {
      throw new ExternalDatasetError("Tardis replay exceeds the total download limit", "TARDIS_TOTAL_SIZE_LIMIT", 413);
    }
    if (minute.messages === 0) {
      throw new ExternalDatasetError(`Tardis minute ${offset} is empty`, "TARDIS_EMPTY_MINUTE", 422);
    }
  }

  replayer.finish();
  const snapshots = replayer.result();
  if (generatedSnapshots !== 1) {
    throw new ExternalDatasetError(
      `Replay requires exactly one generated depth snapshot; received ${generatedSnapshots}`,
      "TARDIS_SNAPSHOT_COUNT"
    );
  }
  if (snapshots.length < 30) {
    throw new ExternalDatasetError("Replay did not produce enough causal L2 samples", "TARDIS_INSUFFICIENT_SNAPSHOTS");
  }
  return {
    snapshots,
    contentSha256: contentHash.digest("hex"),
    sourceUrls,
    stats: {
      downloadedMinutes: request.minutes,
      downloadedBytes,
      parsedMessages,
      depthUpdates,
      generatedSnapshots,
      emittedSnapshots: snapshots.length
    }
  };
}

async function consumeNdjsonMinute(
  body: ReadableStream<Uint8Array>,
  offset: number,
  onLine: (line: string, byteLength: number) => Promise<void>
) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let messages = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > TARDIS_MAX_MINUTE_BYTES) {
        throw new ExternalDatasetError(`Tardis minute ${offset} exceeds the per-minute size limit`, "TARDIS_MINUTE_SIZE_LIMIT", 413);
      }
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > TARDIS_MAX_LINE_BYTES && !buffer.includes("\n")) {
        throw new ExternalDatasetError("Tardis NDJSON line exceeds the approved size", "TARDIS_LINE_SIZE_LIMIT", 413);
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!rawLine.trim()) {
          throw new ExternalDatasetError("Tardis replay contains a disconnect marker", "TARDIS_DISCONNECT");
        }
        const lineBytes = Buffer.byteLength(rawLine, "utf8");
        if (lineBytes > TARDIS_MAX_LINE_BYTES) {
          throw new ExternalDatasetError("Tardis NDJSON line exceeds the approved size", "TARDIS_LINE_SIZE_LIMIT", 413);
        }
        messages += 1;
        if (messages > TARDIS_MAX_MESSAGES_PER_MINUTE) {
          throw new ExternalDatasetError(`Tardis minute ${offset} exceeds the message limit`, "TARDIS_MESSAGE_LIMIT", 413);
        }
        await onLine(rawLine, lineBytes);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const finalLine = buffer.replace(/\r$/, "");
    if (finalLine.trim()) {
      const lineBytes = Buffer.byteLength(finalLine, "utf8");
      if (lineBytes > TARDIS_MAX_LINE_BYTES) {
        throw new ExternalDatasetError("Tardis NDJSON line exceeds the approved size", "TARDIS_LINE_SIZE_LIMIT", 413);
      }
      messages += 1;
      await onLine(finalLine, lineBytes);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ExternalDatasetError) throw error;
    throw new ExternalDatasetError(`Tardis minute ${offset} is not valid UTF-8 NDJSON`, "TARDIS_INVALID_NDJSON", 422, { cause: error });
  } finally {
    reader.releaseLock();
  }
  return { bytes, messages };
}

class BinanceSpotBookReplayer {
  private readonly bids = new Map<string, string>();
  private readonly asks = new Map<string, string>();
  private readonly pending: ParsedDepthUpdate[] = [];
  private readonly snapshots: TardisReplaySnapshot[] = [];
  private lastUpdateId: number | undefined;
  private synchronized = false;
  private snapshotObservedAt: number | undefined;
  private nextSampleAt: number | undefined;

  constructor(
    private readonly request: TardisTrainingRequest,
    private readonly quoteScale: Decimal
  ) {}

  ingest(message: ParsedMessage) {
    this.assertTimestampInWindow(message.observedAt);
    if (message.kind === "snapshot") {
      if (this.lastUpdateId !== undefined) {
        throw new ExternalDatasetError("Replay contains more than one generated snapshot", "TARDIS_MULTIPLE_SNAPSHOTS");
      }
      replaceSide(this.bids, message.bids);
      replaceSide(this.asks, message.asks);
      this.lastUpdateId = message.lastUpdateId;
      this.snapshotObservedAt = message.observedAt;
      this.nextSampleAt = ceilToInterval(message.observedAt, this.request.sampleIntervalMs);
      for (const pending of this.pending) this.applyUpdate(pending);
      this.pending.length = 0;
      return;
    }
    if (this.lastUpdateId === undefined) {
      if (this.pending.length >= MAX_PENDING_DEPTH_EVENTS) {
        throw new ExternalDatasetError("Too many updates arrived before the initial snapshot", "TARDIS_PENDING_LIMIT");
      }
      this.pending.push(message);
      return;
    }
    this.sampleUntil(message.observedAt);
    this.applyUpdate(message);
  }

  finish() {
    if (this.lastUpdateId === undefined || this.snapshotObservedAt === undefined) {
      throw new ExternalDatasetError("Replay is missing its generated initial snapshot", "TARDIS_SNAPSHOT_MISSING");
    }
    if (!this.synchronized) {
      throw new ExternalDatasetError("Replay never synchronized incremental depth with its snapshot", "TARDIS_NOT_SYNCHRONIZED");
    }
    const endExclusive = Date.parse(`${this.request.date}T00:00:00.000Z`) + this.request.minutes * 60_000;
    this.sampleUntil(endExclusive);
  }

  result() {
    return this.snapshots.map(snapshot => ({ observedAt: snapshot.observedAt, book: cloneBook(snapshot.book) }));
  }

  private applyUpdate(update: ParsedDepthUpdate) {
    const last = this.lastUpdateId!;
    if (update.finalUpdateId <= last) return;
    const expected = last + 1;
    if (update.firstUpdateId > expected || update.finalUpdateId < expected) {
      throw new ExternalDatasetError(
        `Binance depth sequence gap: expected ${expected}, received ${update.firstUpdateId}-${update.finalUpdateId}`,
        "TARDIS_SEQUENCE_GAP"
      );
    }
    updateSide(this.bids, update.bids);
    updateSide(this.asks, update.asks);
    this.lastUpdateId = update.finalUpdateId;
    this.synchronized = true;
  }

  private sampleUntil(exclusiveAt: number) {
    while (this.nextSampleAt !== undefined && this.nextSampleAt < exclusiveAt) {
      this.pruneInternalLevels();
      const book = this.makeBook(this.nextSampleAt);
      if (book.bids.length >= 2 && book.asks.length >= 2 && book.bids[0]!.price.lt(book.asks[0]!.price)) {
        this.snapshots.push({ observedAt: this.nextSampleAt, book });
      }
      this.nextSampleAt += this.request.sampleIntervalMs;
    }
  }

  private makeBook(observedAt: number): OrderBook {
    const base = symbolBase(this.request.symbol);
    return {
      symbol: `${base}USDT`,
      base,
      quote: "USDT",
      bids: sortedLevels(this.bids, "bids", this.quoteScale),
      asks: sortedLevels(this.asks, "asks", this.quoteScale),
      lastUpdate: observedAt
    };
  }

  private pruneInternalLevels() {
    pruneSide(this.bids, "bids");
    pruneSide(this.asks, "asks");
  }

  private assertTimestampInWindow(observedAt: number) {
    const startAt = Date.parse(`${this.request.date}T00:00:00.000Z`);
    const endAt = startAt + this.request.minutes * 60_000;
    if (!Number.isSafeInteger(observedAt) || observedAt < startAt || observedAt >= endAt) {
      throw new ExternalDatasetError("Tardis message timestamp is outside the requested UTC window", "TARDIS_TIMESTAMP_RANGE");
    }
  }
}

function parseTardisLine(line: string, expectedSymbol: TardisBinanceAllowedSymbol): ParsedMessage {
  const separator = line.indexOf(" ");
  if (separator <= 0) throw new ExternalDatasetError("Tardis line is missing its local timestamp", "TARDIS_INVALID_LINE");
  const timestamp = line.slice(0, separator);
  const observedAt = Date.parse(timestamp);
  if (!Number.isSafeInteger(observedAt)) throw new ExternalDatasetError("Tardis local timestamp is invalid", "TARDIS_INVALID_TIMESTAMP");
  let envelope: unknown;
  try {
    envelope = JSON.parse(line.slice(separator + 1));
  } catch (error) {
    throw new ExternalDatasetError("Tardis line contains invalid JSON", "TARDIS_INVALID_JSON", 422, { cause: error });
  }
  const object = record(envelope, "Tardis envelope");
  const stream = shortString(object.stream, "stream");
  const data = record(object.data, "Tardis data");
  const lower = expectedSymbol.toLowerCase();
  if (stream === `${lower}@depthSnapshot`) {
    if (object.generated !== true) throw new ExternalDatasetError("Depth snapshot is not marked as generated", "TARDIS_UNTRUSTED_SNAPSHOT");
    return {
      kind: "snapshot",
      observedAt,
      lastUpdateId: safeUpdateId(data.lastUpdateId, "lastUpdateId"),
      bids: levelTuples(data.bids, "snapshot bids", 2_000),
      asks: levelTuples(data.asks, "snapshot asks", 2_000)
    };
  }
  if (stream !== `${lower}@depth@100ms`) {
    throw new ExternalDatasetError(`Unexpected Tardis channel ${stream}`, "TARDIS_CHANNEL_REJECTED");
  }
  if (data.e !== "depthUpdate" || data.s !== expectedSymbol) {
    throw new ExternalDatasetError("Depth update symbol or event type does not match the approved request", "TARDIS_SYMBOL_REJECTED");
  }
  return {
    kind: "depth",
    observedAt,
    firstUpdateId: safeUpdateId(data.U, "U"),
    finalUpdateId: safeUpdateId(data.u, "u"),
    bids: levelTuples(data.b, "depth bids", 5_000),
    asks: levelTuples(data.a, "depth asks", 5_000)
  };
}

function replaceSide(target: Map<string, string>, levels: readonly [string, string][]) {
  target.clear();
  updateSide(target, levels);
}

function updateSide(target: Map<string, string>, levels: readonly [string, string][]) {
  for (const [rawPrice, rawAmount] of levels) {
    const price = positiveDecimal(rawPrice, "price").toString();
    const amount = nonNegativeDecimal(rawAmount, "amount");
    if (amount.isZero()) target.delete(price);
    else target.set(price, amount.toString());
  }
  if (target.size > MAX_INTERNAL_LEVELS_PER_SIDE * 2) {
    throw new ExternalDatasetError("Reconstructed order book exceeds the approved level limit", "TARDIS_BOOK_SIZE_LIMIT", 413);
  }
}

function sortedLevels(side: Map<string, string>, direction: "bids" | "asks", scale: Decimal): Level[] {
  return [...side.entries()]
    .map(([price, amount]) => ({ price: new Decimal(price).mul(scale), amount: new Decimal(amount) }))
    .sort((left, right) => direction === "bids"
      ? right.price.comparedTo(left.price)
      : left.price.comparedTo(right.price))
    .slice(0, STORED_LEVELS_PER_SIDE);
}

function pruneSide(side: Map<string, string>, direction: "bids" | "asks") {
  if (side.size <= MAX_INTERNAL_LEVELS_PER_SIDE) return;
  const keep = [...side.keys()]
    .map(price => new Decimal(price))
    .sort((left, right) => direction === "bids" ? right.comparedTo(left) : left.comparedTo(right))
    .slice(0, MAX_INTERNAL_LEVELS_PER_SIDE)
    .map(price => price.toString());
  const allowed = new Set(keep);
  for (const price of side.keys()) if (!allowed.has(price)) side.delete(price);
}

function levelTuples(value: unknown, label: string, maximum: number): [string, string][] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ExternalDatasetError(`${label} is not a bounded level array`, "TARDIS_INVALID_LEVELS");
  }
  return value.map((item, index) => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") {
      throw new ExternalDatasetError(`${label}[${index}] is invalid`, "TARDIS_INVALID_LEVELS");
    }
    if (item[0].length > 80 || item[1].length > 80) {
      throw new ExternalDatasetError(`${label}[${index}] is too long`, "TARDIS_INVALID_LEVELS");
    }
    return [item[0], item[1]];
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalDatasetError(`${label} must be an object`, "TARDIS_INVALID_MESSAGE");
  }
  return value as Record<string, unknown>;
}

function shortString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new ExternalDatasetError(`${label} must be a short string`, "TARDIS_INVALID_MESSAGE");
  }
  return value;
}

function safeUpdateId(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ExternalDatasetError(`${label} must be a safe update id`, "TARDIS_INVALID_SEQUENCE");
  }
  return value;
}

function symbolBase(symbol: TardisBinanceAllowedSymbol) {
  return symbol.slice(0, -4);
}

function ceilToInterval(value: number, interval: number) {
  return Math.ceil(value / interval) * interval;
}

function cloneBook(book: OrderBook): OrderBook {
  const cloneSide = (side: Level[]) => side.map(level => ({ price: new Decimal(level.price), amount: new Decimal(level.amount) }));
  return { ...book, bids: cloneSide(book.bids), asks: cloneSide(book.asks) };
}

function positiveDecimal(value: Decimal.Value, label: string) {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lte(0)) throw new ExternalDatasetError(`${label} must be positive`, "TARDIS_INVALID_NUMBER");
  return parsed;
}

function nonNegativeDecimal(value: Decimal.Value, label: string) {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lt(0)) throw new ExternalDatasetError(`${label} must be non-negative`, "TARDIS_INVALID_NUMBER");
  return parsed;
}

function positiveSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}
