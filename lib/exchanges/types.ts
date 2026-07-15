import Decimal from "decimal.js";

export type Side = "BUY" | "SELL";
export type Level = { price: Decimal; amount: Decimal };
export type OrderBook = {
  symbol: string;
  base: string;
  quote: string;
  bids: Level[];
  asks: Level[];
  lastUpdate: number;
};
export type MarketOptions = {
  amountSteps: Record<string, Decimal>;
  priceSteps: Record<string, Decimal>;
  /** Raw Bitget minTradeUSDT for each symbol. */
  minTradeUsdtBySymbol?: Record<string, Decimal>;
  /**
   * Optional pre-converted minimum in the symbol's quote asset. When absent,
   * the arbitrage core values minTradeUSDT through a live quote/USDT book.
   */
  minOrderQuoteBySymbol?: Record<string, Decimal>;
  /** Official taker fee for a symbol; global bot settings are a conservative fallback. */
  takerFeeBpsBySymbol?: Record<string, Decimal>;
  /** @deprecated Legacy dashboard field. Bitget execution never uses rial/toman scaling. */
  minOrderRial: Decimal;
  /** Legacy global USDT minimum used only when per-symbol metadata is unavailable. */
  minOrderUsdt: Decimal;
};
export type Wallet = { asset: string; available: Decimal; blocked: Decimal };
export type BitgetOrder = {
  id: string;
  status: string;
  amount: Decimal;
  matchedAmount: Decimal;
  unmatchedAmount: Decimal;
  totalPrice: Decimal;
  averagePrice: Decimal;
  fee: Decimal;
  /** Single fee asset; may be omitted when `feeBreakdown` contains multiple assets. */
  feeAsset?: string;
  /** Authoritative when Bitget charges multiple assets (for example BGB plus received asset). */
  feeBreakdown?: Array<{ asset: string; amount: Decimal }>;
  raw: unknown;
};

export type MarginMarket = {
  symbol: string;
  base: string;
  quote: string;
  positionFeeRate: Decimal;
  maxLeverage: Decimal;
  sellEnabled: boolean;
  buyEnabled: boolean;
  raw: unknown;
};

export type MarginPosition = {
  id: string;
  base: string;
  quote: string;
  side: "BUY" | "SELL";
  status: string;
  collateral: Decimal;
  leverage: Decimal;
  entryPrice: Decimal;
  exitPrice: Decimal;
  delegatedAmount: Decimal;
  liability: Decimal;
  liabilityInOrder: Decimal;
  assetInOrder: Decimal;
  marginRatio: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl: Decimal;
  markPrice: Decimal;
  liquidationPrice: Decimal;
  openedAt: string | null;
  closedAt: string | null;
  raw: unknown;
};

export type CandleSeries = {
  symbol: string;
  resolution: string;
  timestamps: number[];
  open: Decimal[];
  high: Decimal[];
  low: Decimal[];
  close: Decimal[];
  volume: Decimal[];
};
