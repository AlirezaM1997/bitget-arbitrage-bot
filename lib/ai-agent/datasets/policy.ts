import { z } from "zod";
import {
  TARDIS_BINANCE_ALLOWED_SYMBOLS,
  type TardisTrainingRequest
} from "./types";

export const TARDIS_DATA_FEED_ORIGIN = "https://api.tardis.dev" as const;
export const TARDIS_DATA_FEED_PATH = "/v1/data-feeds/binance" as const;
export const TARDIS_MIN_MINUTES = 3;
export const TARDIS_MAX_MINUTES = 15;
export const TARDIS_MAX_MINUTE_BYTES = 8 * 1024 * 1024;
export const TARDIS_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const TARDIS_MAX_LINE_BYTES = 1024 * 1024;
export const TARDIS_MAX_MESSAGES_PER_MINUTE = 2_500;
export const TARDIS_REQUEST_TIMEOUT_MS = 30_000;

const earliestBySymbol: Record<(typeof TARDIS_BINANCE_ALLOWED_SYMBOLS)[number], string> = {
  BTCUSDT: "2019-12-01",
  ETHUSDT: "2020-03-01",
  // Tardis documents complete Binance symbol coverage from March 2021.
  SOLUSDT: "2021-04-01"
};

export const tardisTrainingRequestSchema = z.object({
  symbol: z.enum(TARDIS_BINANCE_ALLOWED_SYMBOLS),
  date: z.string().regex(/^\d{4}-\d{2}-01$/, "Date must be the first UTC day of a month (YYYY-MM-01)"),
  minutes: z.coerce.number().int().min(TARDIS_MIN_MINUTES).max(TARDIS_MAX_MINUTES),
  sampleIntervalMs: z.union([z.literal(1_000), z.literal(2_000)]).default(1_000),
  horizonMs: z.union([z.literal(5_000), z.literal(10_000), z.literal(30_000)]).default(5_000)
}).strict().superRefine((input, context) => {
  const startAt = Date.parse(`${input.date}T00:00:00.000Z`);
  if (!Number.isFinite(startAt) || new Date(startAt).toISOString().slice(0, 10) !== input.date) {
    context.addIssue({ code: "custom", path: ["date"], message: "Date is not a valid UTC calendar date" });
    return;
  }
  if (input.date < earliestBySymbol[input.symbol]) {
    context.addIssue({
      code: "custom",
      path: ["date"],
      message: `${input.symbol} free sample coverage starts at ${earliestBySymbol[input.symbol]}`
    });
  }
  // Avoid incomplete current/future slices. The clock check is repeated at job start.
  if (startAt + input.minutes * 60_000 > Date.now() - 86_400_000) {
    context.addIssue({ code: "custom", path: ["date"], message: "Dataset day must be at least 24 hours in the past" });
  }
  if (input.horizonMs >= input.minutes * 60_000 / 3) {
    context.addIssue({ code: "custom", path: ["horizonMs"], message: "Label horizon is too long for the requested sample" });
  }
});

export function parseTardisTrainingRequest(input: unknown): TardisTrainingRequest {
  return tardisTrainingRequestSchema.parse(input) as TardisTrainingRequest;
}

/**
 * Constructs the only external URL this importer can access. Callers cannot
 * provide a host, path, channel, arbitrary symbol or query string.
 */
export function buildTardisMinuteUrl(request: TardisTrainingRequest, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= request.minutes) {
    throw new Error("Tardis minute offset is outside the approved request window");
  }
  const url = new URL(TARDIS_DATA_FEED_PATH, TARDIS_DATA_FEED_ORIGIN);
  url.searchParams.set("from", request.date);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("filters", JSON.stringify([
    { channel: "depth", symbols: [request.symbol.toLowerCase()] },
    { channel: "depthSnapshot", symbols: [request.symbol.toLowerCase()] }
  ]));
  assertApprovedTardisUrl(url);
  return url;
}

export function assertApprovedTardisUrl(url: URL) {
  if (url.protocol !== "https:" || url.origin !== TARDIS_DATA_FEED_ORIGIN || url.pathname !== TARDIS_DATA_FEED_PATH) {
    throw new Error("External dataset URL is not allowlisted");
  }
  if (url.username || url.password || url.port) throw new Error("External dataset URL contains forbidden authority fields");
}
