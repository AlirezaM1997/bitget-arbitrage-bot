import type { OrderBook } from "@/lib/exchanges/types";

export type OrderbookObservation = {
  observedAt: number;
  book: OrderBook;
};

type HistoryGlobal = typeof globalThis & {
  __bitgetOrderbookHistory?: Map<string, OrderbookObservation[]>;
};

/** Keeps only a small in-process rolling window; no Paper snapshot is persisted. */
export function recordOrderbookObservations(
  books: OrderBook[],
  observedAt: number,
  options: { maxAgeMs?: number; maxSamples?: number; minSampleGapMs?: number } = {}
) {
  const globalHistory = globalThis as HistoryGlobal;
  globalHistory.__bitgetOrderbookHistory ??= new Map();
  const history = globalHistory.__bitgetOrderbookHistory;
  const maxAgeMs = Math.max(2_000, options.maxAgeMs ?? 60_000);
  const maxSamples = Math.max(2, Math.min(120, options.maxSamples ?? 30));
  const minSampleGapMs = Math.max(100, options.minSampleGapMs ?? 500);
  for (const book of books) {
    const previous = history.get(book.symbol) ?? [];
    const fresh = previous.filter(item => observedAt - item.observedAt <= maxAgeMs);
    const last = fresh[fresh.length - 1];
    const sourceAdvanced = !last
      || book.lastUpdate > last.book.lastUpdate
      || bookFingerprint(book) !== bookFingerprint(last.book);
    // Repeated REST responses are not independent confirmations. Counting the
    // same exchange snapshot every second made persistence and CUSUM gates look
    // stronger without any new market information.
    if (sourceAdvanced && (!last || observedAt - last.observedAt >= minSampleGapMs)) {
      fresh.push({ observedAt, book });
    }
    history.set(book.symbol, fresh.slice(-maxSamples));
  }
  for (const [symbol, observations] of history) {
    const fresh = observations.filter(item => observedAt - item.observedAt <= maxAgeMs);
    if (fresh.length) history.set(symbol, fresh);
    else history.delete(symbol);
  }
  return history as ReadonlyMap<string, readonly OrderbookObservation[]>;
}

function bookFingerprint(book: OrderBook) {
  const levels = (side: OrderBook["bids"]) => side.slice(0, 10)
    .map(level => `${level.price.toString()}:${level.amount.toString()}`)
    .join("|");
  return `${book.lastUpdate}:${levels(book.bids)}::${levels(book.asks)}`;
}

export function clearOrderbookObservations() {
  const globalHistory = globalThis as HistoryGlobal;
  globalHistory.__bitgetOrderbookHistory?.clear();
}
