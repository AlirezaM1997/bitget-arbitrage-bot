import type { OrderBook } from "@/lib/exchanges/types";

export type AiOrderbookObservation = {
  observedAt: number;
  book: OrderBook;
};

type HistoryGlobal = typeof globalThis & {
  __bitgetAiOrderbookHistory?: Map<string, AiOrderbookObservation[]>;
};

/** AI-owned, bounded, in-memory market history. It does not depend on a strategy engine being enabled. */
export function recordAiOrderbookObservations(
  books: readonly OrderBook[],
  observedAt: number,
  options: { maxAgeMs: number; maxSamples: number; minSampleGapMs?: number }
) {
  const root = globalThis as HistoryGlobal;
  root.__bitgetAiOrderbookHistory ??= new Map();
  const history = root.__bitgetAiOrderbookHistory;
  const maxAgeMs = Math.max(3_000, Math.floor(options.maxAgeMs));
  const maxSamples = Math.max(3, Math.min(360, Math.floor(options.maxSamples)));
  const minSampleGapMs = Math.max(100, Math.floor(options.minSampleGapMs ?? 500));

  for (const book of books) {
    if (book.quote.toUpperCase() !== "USDT") continue;
    const symbol = book.symbol.toUpperCase();
    const fresh = (history.get(symbol) ?? [])
      .filter(item => observedAt - item.observedAt <= maxAgeMs);
    const last = fresh.at(-1);
    if ((!last || fingerprint(last.book) !== fingerprint(book))
      && (!last || observedAt - last.observedAt >= minSampleGapMs)) {
      fresh.push({ observedAt, book });
    }
    history.set(symbol, fresh.slice(-maxSamples));
  }

  for (const [symbol, observations] of history) {
    const fresh = observations.filter(item => observedAt - item.observedAt <= maxAgeMs);
    if (fresh.length) history.set(symbol, fresh);
    else history.delete(symbol);
  }
  return history as ReadonlyMap<string, readonly AiOrderbookObservation[]>;
}

export function clearAiOrderbookObservations() {
  (globalThis as HistoryGlobal).__bitgetAiOrderbookHistory?.clear();
}

function fingerprint(book: OrderBook) {
  const side = (rows: OrderBook["bids"]) => rows.slice(0, 12)
    .map(level => `${level.price.toString()}:${level.amount.toString()}`)
    .join("|");
  return `${book.lastUpdate}:${side(book.bids)}::${side(book.asks)}`;
}
