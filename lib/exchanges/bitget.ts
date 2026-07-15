import { createHmac } from "node:crypto";
import Decimal from "decimal.js";
import { config } from "@/lib/config";
import {
  getBitgetRuntimeSettings,
  type BitgetAccountMode,
  type BitgetRuntimeSettings
} from "@/lib/bitget-runtime-settings";
import { assertLiveOwnerForOrder } from "@/lib/runtime/live-owner";
import type {
  BitgetOrder,
  CandleSeries,
  MarketOptions,
  OrderBook,
  Side,
  Wallet
} from "./types";

type Json = Record<string, unknown>;
type HttpMethod = "GET" | "POST";

export type SpotSymbol = {
  symbol: string;
  base: string;
  quote: string;
  status: string;
  priceStep: Decimal;
  amountStep: Decimal;
  quoteStep: Decimal;
  minTradeUsdt: Decimal;
  takerFeeRate: Decimal;
  makerFeeRate: Decimal;
  buyLimitPriceRatio: Decimal;
  sellLimitPriceRatio: Decimal;
  raw: Json;
};

export type BitgetMarketOptions = MarketOptions & {
  minOrderBySymbol?: Record<string, Decimal>;
  quoteBySymbol?: Record<string, string>;
  takerFeeRates?: Record<string, Decimal>;
  makerFeeRates?: Record<string, Decimal>;
};

export type SpotOrder = BitgetOrder & {
  symbol?: string;
  clientOrderId?: string;
  side?: Side;
  feeAsset?: string;
  feeDetail?: Json;
};

export type SpotPortfolioSummary = {
  totalEstimatedUsdt: Decimal;
  availableUsdt: Decimal;
  blockedUsdt: Decimal;
  unpricedAssets: Array<{ asset: string; amount: Decimal }>;
  /** @deprecated Compatibility aliases; values are USDT, not Toman. */
  totalEstimatedToman: Decimal;
  /** @deprecated Compatibility aliases; values are USDT, not Toman. */
  availableToman: Decimal;
  /** @deprecated Compatibility aliases; values are USDT, not Toman. */
  blockedToman: Decimal;
  /** UTA's USD-denominated account equity, when account mode is UTA. */
  accountEquityUsd?: Decimal;
};

type WebSocketEvent = { data?: unknown };
type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type WebSocketFactory = (url: string) => WebSocketLike;

export type BitgetClientOptions = {
  baseUrl?: string;
  websocketUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  credentials?: { apiKey: string; apiSecret: string; passphrase: string };
  accountMode?: BitgetAccountMode;
  demoTrading?: boolean;
  webSocketFactory?: WebSocketFactory;
  disableWebSocket?: boolean;
  websocketBootstrapMs?: number;
  orderBookMaxAgeMs?: number;
  orderBookRestRateLimit?: number;
  sharedMarketData?: boolean;
  triangleAnchor?: string;
  assertOrderPermission?: () => Promise<unknown>;
  /** Unit-test escape hatch; requires injected fetch, credentials, and NODE_ENV=test. */
  allowPrivateTestTransport?: boolean;
};

type CachedValue<T> = { value: T; expiresAt: number };
type MarketState = {
  symbols?: CachedValue<SpotSymbol[]>;
  symbolsPromise?: Promise<SpotSymbol[]>;
  tickers?: CachedValue<Ticker[]>;
  tickersPromise?: Promise<Ticker[]>;
  feed?: BitgetOrderBookFeed;
  feedSignature?: string;
  bootstrapPromise?: Promise<void>;
  refreshPromise?: Promise<void>;
};

type Ticker = {
  symbol: string;
  bid: Decimal;
  ask: Decimal;
  last: Decimal;
  bidSize?: Decimal;
  askSize?: Decimal;
  timestamp?: number;
};

type BookSnapshot = {
  book: OrderBook;
  sequence?: number;
};

const GLOBAL_MARKET_STATE = Symbol.for("bitget-arbitrage.classic-v2-market-data.v2");
const SYMBOL_CACHE_MS = 60 * 60 * 1_000;
const TICKER_CACHE_MS = 2_000;
const DEFAULT_BOOK_MAX_AGE_MS = 3_000;
const DEFAULT_WS_BOOTSTRAP_MS = 1_250;
const WS_CHANNELS_PER_CONNECTION = 45;
const WS_HEARTBEAT_MS = 25_000;
const WS_PONG_TIMEOUT_MS = 65_000;
const DEFAULT_REST_BOOK_RATE = 18;

function globalMarketState(): MarketState {
  const root = globalThis as typeof globalThis & { [GLOBAL_MARKET_STATE]?: MarketState };
  return root[GLOBAL_MARKET_STATE] ??= {};
}

export class BitgetClient {
  readonly baseUrl: string;
  private readonly websocketUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly explicitCredentials?: BitgetClientOptions["credentials"];
  private readonly accountMode: BitgetAccountMode;
  private readonly demoTrading: boolean;
  private readonly websocketFactory?: WebSocketFactory;
  private readonly websocketBootstrapMs: number;
  private readonly orderBookMaxAgeMs: number;
  private readonly orderBookRestRateLimit: number;
  private readonly triangleAnchor: string;
  private readonly assertOrderPermission: () => Promise<unknown>;
  private readonly allowPrivateTestTransport: boolean;
  private readonly state: MarketState;
  private readonly orderSymbols = new Map<string, string>();
  private restBookRequestStarts: number[] = [];
  private restBookGate: Promise<void> = Promise.resolve();
  private utaAccount?: CachedValue<Json>;
  private utaAccountPromise?: Promise<Json>;

  constructor(options: BitgetClientOptions = {}) {
    const dashboardRuntime = getBitgetRuntimeSettings();
    this.baseUrl = normalizeHttpBase(options.baseUrl ?? config.BITGET_API_BASE ?? process.env.BITGET_API_BASE ?? "https://api.bitget.com");
    this.websocketUrl = normalizeWebSocketUrl(options.websocketUrl ?? config.BITGET_WS_PUBLIC ?? process.env.BITGET_WS_PUBLIC ?? "wss://ws.bitget.com/v2/ws/public");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.explicitCredentials = options.credentials;
    this.accountMode = options.accountMode ?? dashboardRuntime.bitgetAccountMode;
    this.demoTrading = options.demoTrading ?? dashboardRuntime.bitgetDemoTrading;
    this.websocketBootstrapMs = boundedInteger(options.websocketBootstrapMs, DEFAULT_WS_BOOTSTRAP_MS, 0, 30_000);
    this.orderBookMaxAgeMs = boundedInteger(options.orderBookMaxAgeMs, DEFAULT_BOOK_MAX_AGE_MS, 250, 60_000);
    this.orderBookRestRateLimit = boundedInteger(options.orderBookRestRateLimit, DEFAULT_REST_BOOK_RATE, 1, 20);
    this.triangleAnchor = normalizeAsset(options.triangleAnchor ?? process.env.BITGET_TRIANGLE_ANCHOR ?? "USDT");
    const ownerSettings: BitgetRuntimeSettings = {
      bitgetAccountMode: this.accountMode,
      bitgetDemoTrading: this.demoTrading
    };
    this.assertOrderPermission = options.assertOrderPermission
      ?? (() => assertLiveOwnerForOrder(ownerSettings));
    this.allowPrivateTestTransport = Boolean(
      options.allowPrivateTestTransport
      && options.fetch
      && options.credentials
      && process.env.NODE_ENV === "test"
    );

    if (!options.disableWebSocket) {
      this.websocketFactory = options.webSocketFactory ?? defaultWebSocketFactory();
    }

    const hasInjectedMarketDependency = Boolean(
      options.fetch || options.now || options.sleep || options.webSocketFactory || options.disableWebSocket
      || options.baseUrl || options.websocketUrl || options.triangleAnchor
    );
    const useSharedState = options.sharedMarketData ?? !hasInjectedMarketDependency;
    this.state = useSharedState ? globalMarketState() : {};
  }

  async getSymbols(): Promise<SpotSymbol[]> {
    const cached = this.state.symbols;
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (this.state.symbolsPromise) return this.state.symbolsPromise;

    const pending = this.request<unknown>("GET", "/api/v2/spot/public/symbols", undefined, undefined, false)
      .then(data => {
        if (!Array.isArray(data)) throw new Error("Bitget symbols response is not an array");
        const symbols = data.map((item, index) => parseSpotSymbol(item, index));
        if (!symbols.length) throw new Error("Bitget returned no Spot symbols");
        const duplicate = firstDuplicate(symbols.map(item => item.symbol));
        if (duplicate) throw new Error(`Bitget returned duplicate Spot symbol ${duplicate}`);
        const immutable = Object.freeze(symbols.map(symbol => Object.freeze({
          ...symbol,
          raw: Object.freeze({ ...symbol.raw })
        }))) as unknown as SpotSymbol[];
        this.state.symbols = { value: immutable, expiresAt: this.now() + SYMBOL_CACHE_MS };
        return immutable;
      })
      .finally(() => {
        this.state.symbolsPromise = undefined;
      });
    this.state.symbolsPromise = pending;
    return pending;
  }

  async getTriangleSymbols(): Promise<SpotSymbol[]> {
    return triangleRelevantSymbols(await this.getSymbols(), this.triangleAnchor);
  }

  async getMarketOptions(): Promise<BitgetMarketOptions> {
    const symbols = await this.getSymbols();
    const online = symbols.filter(symbol => symbol.status === "online");
    const amountSteps: Record<string, Decimal> = {};
    const priceSteps: Record<string, Decimal> = {};
    const minOrderBySymbol: Record<string, Decimal> = {};
    const quoteBySymbol: Record<string, string> = {};
    const takerFeeRates: Record<string, Decimal> = {};
    const makerFeeRates: Record<string, Decimal> = {};
    const minTradeUsdtBySymbol: Record<string, Decimal> = {};
    const minOrderQuoteBySymbol: Record<string, Decimal> = {};
    const takerFeeBpsBySymbol: Record<string, Decimal> = {};

    for (const symbol of online) {
      amountSteps[symbol.symbol] = symbol.amountStep;
      priceSteps[symbol.symbol] = symbol.priceStep;
      minOrderBySymbol[symbol.symbol] = symbol.minTradeUsdt;
      quoteBySymbol[symbol.symbol] = symbol.quote;
      takerFeeRates[symbol.symbol] = symbol.takerFeeRate;
      makerFeeRates[symbol.symbol] = symbol.makerFeeRate;
      minTradeUsdtBySymbol[symbol.symbol] = symbol.minTradeUsdt;
      takerFeeBpsBySymbol[symbol.symbol] = symbol.takerFeeRate.mul(10_000);
      if (symbol.quote === "USDT") minOrderQuoteBySymbol[symbol.symbol] = symbol.minTradeUsdt;
    }

    const conservativeGlobalUsdtMinimum = Decimal.max(
      1,
      ...online.map(symbol => symbol.minTradeUsdt)
    );

    return {
      amountSteps,
      priceSteps,
      // Legacy field retained until every engine call site uses minOrderBySymbol.
      // A conservative legacy value prevents accidental interpretation as 1 USDT.
      minOrderRial: conservativeGlobalUsdtMinimum,
      minOrderUsdt: conservativeGlobalUsdtMinimum,
      minTradeUsdtBySymbol,
      minOrderQuoteBySymbol,
      takerFeeBpsBySymbol,
      minOrderBySymbol,
      quoteBySymbol,
      takerFeeRates,
      makerFeeRates
    };
  }

  async getCandles(symbol: string, resolution = "60", countback = 120): Promise<CandleSeries> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const granularity = candleGranularity(resolution);
    if (!Number.isFinite(countback)) throw new Error("Bitget candle countback must be finite");
    const safeCount = Math.max(20, Math.min(1_000, Math.floor(countback)));
    const params = new URLSearchParams({
      symbol: normalizedSymbol,
      granularity,
      limit: String(safeCount)
    });
    const data = await this.request<unknown>("GET", "/api/v2/spot/market/candles", params, undefined, false);
    if (!Array.isArray(data)) throw new Error(`Bitget candles response for ${normalizedSymbol} is not an array`);

    const rows = data.map((value, index) => parseCandle(value, normalizedSymbol, index));
    rows.sort((a, b) => a.timestamp - b.timestamp);
    if (firstDuplicate(rows.map(row => String(row.timestamp)))) {
      throw new Error(`Bitget candles response for ${normalizedSymbol} contains duplicate timestamps`);
    }
    return {
      symbol: normalizedSymbol,
      resolution,
      timestamps: rows.map(row => Math.floor(row.timestamp / 1_000)),
      open: rows.map(row => row.open),
      high: rows.map(row => row.high),
      low: rows.map(row => row.low),
      close: rows.map(row => row.close),
      volume: rows.map(row => row.volume)
    };
  }

  async getAllOrderBooks(): Promise<OrderBook[]> {
    const relevant = await this.getTriangleSymbols();
    if (!relevant.length) throw new Error(`Bitget has no complete online Spot triangle anchored at ${this.triangleAnchor}`);
    const feed = this.ensureOrderBookFeed(relevant);

    if (!this.state.bootstrapPromise) {
      this.state.bootstrapPromise = this.bootstrapOrderBooks(feed, relevant)
        .finally(() => {
          this.state.bootstrapPromise = undefined;
        });
    }
    await this.state.bootstrapPromise;

    const staleOrMissing = relevant.filter(symbol => !feed.isFresh(symbol.symbol, this.now(), this.orderBookMaxAgeMs));
    if (staleOrMissing.length) {
      if (!this.state.refreshPromise) {
        this.state.refreshPromise = this.refreshOrderBooks(feed, staleOrMissing)
          .finally(() => {
            this.state.refreshPromise = undefined;
          });
      }
      await this.state.refreshPromise;
    }

    const fresh = feed.snapshot(this.now(), this.orderBookMaxAgeMs);
    const completeSymbols = new Set(triangleRelevantSymbols(
      fresh.map(book => syntheticSpotSymbol(book)),
      this.triangleAnchor
    ).map(symbol => symbol.symbol));
    const books = fresh.filter(book => completeSymbols.has(book.symbol));
    if (!books.length) {
      throw new Error(`Bitget orderbook cache contains no complete fresh ${this.triangleAnchor} triangle`);
    }
    return books;
  }

  /**
   * Coherent, exchange-wide top-of-book snapshot for discovery. Bitget's
   * all-tickers endpoint carries bid/ask prices and sizes for every Spot
   * symbol in one response, avoiding a multi-second REST sweep that makes the
   * first markets stale before the last market arrives.
   */
  async getTriangleScanOrderBooks(): Promise<OrderBook[]> {
    const [relevant, tickers] = await Promise.all([
      this.getTriangleSymbols(),
      this.getTickers()
    ]);
    // The all-tickers response is one coherent discovery snapshot. Individual
    // ticker `ts` values are last-change times and can differ by minutes on an
    // inactive market even though bid/ask values arrived in the same response.
    const snapshotAt = this.now();
    const tickerBySymbol = new Map(tickers.map(ticker => [ticker.symbol, ticker]));
    const books = relevant.flatMap(symbol => {
      const book = tickerOrderBook(symbol, tickerBySymbol.get(symbol.symbol), snapshotAt);
      return book ? [book] : [];
    });
    const completeSymbols = new Set(triangleRelevantSymbols(
      books.map(book => syntheticSpotSymbol(book)),
      this.triangleAnchor
    ).map(symbol => symbol.symbol));
    return books.filter(book => completeSymbols.has(book.symbol));
  }

  /** Fetches deep books only for candidates selected by the full-market pass. */
  async getOrderBooksForSymbols(symbolNames: string[]): Promise<OrderBook[]> {
    const requested = new Set(symbolNames.map(normalizeSymbol));
    if (!requested.size) return [];
    const metadata = (await this.getTriangleSymbols()).filter(symbol => requested.has(symbol.symbol));
    const results = await mapWithConcurrency(metadata, 6, async symbol => {
      try {
        return await this.fetchOrderBook(symbol);
      } catch {
        return undefined;
      }
    });
    return results.filter((book): book is OrderBook => Boolean(book));
  }

  async getWallets(): Promise<Wallet[]> {
    if (this.accountMode === "uta") {
      const account = await this.getUtaAccount();
      if (!Array.isArray(account.assets)) throw new Error("Bitget UTA account assets response is not an array");
      const wallets = account.assets.map((item, index) => parseUtaWallet(item, index));
      const duplicate = firstDuplicate(wallets.map(wallet => wallet.asset));
      if (duplicate) throw new Error(`Bitget returned duplicate UTA account asset ${duplicate}`);
      return wallets;
    }
    const params = new URLSearchParams({ assetType: "all" });
    const data = await this.request<unknown>("GET", "/api/v2/spot/account/assets", params, undefined, true);
    if (!Array.isArray(data)) throw new Error("Bitget account assets response is not an array");
    const wallets = data.map((item, index) => parseWallet(item, index));
    const duplicate = firstDuplicate(wallets.map(wallet => wallet.asset));
    if (duplicate) throw new Error(`Bitget returned duplicate account asset ${duplicate}`);
    return wallets;
  }

  async getSpotUsdtWallet(): Promise<Wallet> {
    if (this.accountMode === "uta") {
      const wallets = await this.getWallets();
      return wallets.find(wallet => wallet.asset === "USDT") ?? {
        asset: "USDT",
        available: new Decimal(0),
        blocked: new Decimal(0)
      };
    }
    const params = new URLSearchParams({ coin: "USDT" });
    const data = await this.request<unknown>("GET", "/api/v2/spot/account/assets", params, undefined, true);
    if (!Array.isArray(data)) throw new Error("Bitget USDT account asset response is not an array");
    const raw = data.find(item => isRecord(item) && String(item.coin ?? "").toUpperCase() === "USDT");
    if (!raw) throw new Error("Bitget Spot USDT wallet was not found");
    return parseWallet(raw, 0);
  }

  /** Compatibility bridge for the pre-Bitget scanner; the returned asset is explicitly USDT. */
  async getSpotTomanWallet(): Promise<Wallet> {
    return this.getSpotUsdtWallet();
  }

  async getSpotPortfolioSummary(): Promise<SpotPortfolioSummary> {
    if (this.accountMode === "uta") {
      const account = await this.getUtaAccount();
      const wallets = Array.isArray(account.assets)
        ? account.assets.map((item, index) => parseUtaWallet(item, index))
        : (() => { throw new Error("Bitget UTA account assets response is not an array"); })();
      const usdt = wallets.find(wallet => wallet.asset === "USDT") ?? {
        asset: "USDT",
        available: new Decimal(0),
        blocked: new Decimal(0)
      };
      const totalEstimatedUsdt = requiredNonNegativeDecimal(account, "usdtEquity", "Bitget UTA USDT equity");
      const accountEquityUsd = requiredNonNegativeDecimal(account, "accountEquity", "Bitget UTA USD account equity");
      return {
        totalEstimatedUsdt,
        availableUsdt: usdt.available,
        blockedUsdt: usdt.blocked,
        unpricedAssets: [],
        totalEstimatedToman: totalEstimatedUsdt,
        availableToman: usdt.available,
        blockedToman: usdt.blocked,
        accountEquityUsd
      };
    }
    const [wallets, symbols, tickers] = await Promise.all([
      this.getWallets(),
      this.getSymbols(),
      this.getTickers()
    ]);
    const usdt = wallets.find(wallet => wallet.asset === "USDT") ?? {
      asset: "USDT",
      available: new Decimal(0),
      blocked: new Decimal(0)
    };
    const rates = buildUsdtValuationRates(symbols, tickers);
    let totalEstimatedUsdt = new Decimal(0);
    const unpricedAssets: Array<{ asset: string; amount: Decimal }> = [];
    for (const wallet of wallets) {
      const amount = wallet.available.plus(wallet.blocked);
      if (amount.lte(0)) continue;
      if (wallet.asset === "USDT") {
        totalEstimatedUsdt = totalEstimatedUsdt.plus(amount);
        continue;
      }
      const rate = bestConversionRate(wallet.asset, "USDT", rates, 3);
      if (!rate) {
        unpricedAssets.push({ asset: wallet.asset, amount });
        continue;
      }
      totalEstimatedUsdt = totalEstimatedUsdt.plus(amount.mul(rate));
    }
    return {
      totalEstimatedUsdt,
      availableUsdt: usdt.available,
      blockedUsdt: usdt.blocked,
      unpricedAssets,
      totalEstimatedToman: totalEstimatedUsdt,
      availableToman: usdt.available,
      blockedToman: usdt.blocked
    };
  }

  /**
   * The legacy method name is retained for the executor contract. On Bitget it
   * always submits a protected IOC limit order; it never submits a raw market order.
   */
  async placeMarketOrder(input: {
    side: Side;
    base: string;
    quote: string;
    amountBase: Decimal;
    expectedPrice: Decimal;
    clientOrderId: string;
  }): Promise<SpotOrder> {
    const side = normalizeSide(input.side);
    const base = normalizeAsset(input.base);
    const quote = normalizeAsset(input.quote);
    const symbolName = `${base}${quote}`;
    const clientOid = normalizeClientOrderId(input.clientOrderId);
    const amount = positiveDecimal(input.amountBase, "order amount");
    const price = positiveDecimal(input.expectedPrice, "protected order price");
    const symbols = await this.getSymbols();
    const symbol = symbols.find(item => item.symbol === symbolName);
    if (!symbol || symbol.status !== "online" || symbol.base !== base || symbol.quote !== quote) {
      throw new Error(`Order rejected: Bitget Spot symbol ${symbolName} is not online`);
    }
    if (symbol.minTradeUsdt.lte(0)) {
      throw new Error(`Order rejected: Bitget minTradeUSDT is unavailable for ${symbolName}`);
    }
    assertStepAligned(amount, symbol.amountStep, `${symbolName} amount`);
    assertStepAligned(price, symbol.priceStep, `${symbolName} price`);
    const quoteNotional = amount.mul(price);
    let notionalUsdt = quoteNotional;
    if (quote !== "USDT") {
      const tickers = await this.getTickers();
      const quoteUsdtRate = directUsdtRate(quote, symbols, tickers);
      if (!quoteUsdtRate) {
        throw new Error(`Order rejected: cannot validate ${symbolName} minTradeUSDT because ${quote}/USDT has no live direct ticker`);
      }
      notionalUsdt = quoteNotional.mul(quoteUsdtRate);
    }
    if (notionalUsdt.lt(symbol.minTradeUsdt)) {
      throw new Error(`Order rejected: ${symbolName} estimated notional ${notionalUsdt.toString()} USDT is below ${symbol.minTradeUsdt.toString()} USDT`);
    }

    const path = this.accountMode === "uta"
      ? "/api/v3/trade/place-order"
      : "/api/v2/spot/trade/place-order";
    const body: Json = this.accountMode === "uta"
      ? {
          category: "SPOT",
          symbol: symbolName,
          side: side.toLowerCase(),
          orderType: "limit",
          timeInForce: "ioc",
          price: price.toString(),
          qty: amount.toString(),
          clientOid
        }
      : {
          symbol: symbolName,
          side: side.toLowerCase(),
          orderType: "limit",
          force: "ioc",
          price: price.toString(),
          size: amount.toString(),
          clientOid
        };

    await this.assertOrderPermission();
    let data: unknown;
    try {
      data = await this.request<unknown>("POST", path, undefined, body, true);
    } catch (error) {
      if (error instanceof BitgetResponseError && error.definitive) {
        throw new Error(`Order rejected: ${error.message}`, { cause: error });
      }
      throw error;
    }
    if (!isRecord(data)) throw new Error("Bitget place-order response has no data object");
    const orderId = normalizeLookupId(data.orderId, "Bitget order id");
    const returnedClientOid = data.clientOid == null ? clientOid : normalizeClientOrderId(String(data.clientOid));
    if (returnedClientOid !== clientOid) throw new Error("Bitget place-order response returned a different clientOid");
    this.rememberOrder(symbolName, orderId, clientOid);
    return {
      id: orderId,
      clientOrderId: clientOid,
      symbol: symbolName,
      side,
      status: "Active",
      amount,
      matchedAmount: new Decimal(0),
      unmatchedAmount: amount,
      totalPrice: new Decimal(0),
      averagePrice: new Decimal(0),
      fee: new Decimal(0),
      feeBreakdown: [],
      raw: data
    };
  }

  async getOrderStatus(id: string): Promise<SpotOrder> {
    const orderId = normalizeLookupId(id, "Bitget order id");
    return this.getOrderInfo(new URLSearchParams({ orderId }), { orderId });
  }

  async getOrderStatusByClientOrderId(clientOrderId: string): Promise<SpotOrder> {
    const clientOid = normalizeClientOrderId(clientOrderId);
    return this.getOrderInfo(new URLSearchParams({ clientOid }), { clientOid });
  }

  async cancelOrder(id: string, symbol?: string): Promise<void> {
    const orderId = normalizeLookupId(id, "Bitget order id");
    if (this.accountMode === "uta") {
      await this.assertOrderPermission();
      const data = await this.request<unknown>("POST", "/api/v3/trade/cancel-order", undefined, {
        category: "SPOT",
        orderId
      }, true);
      assertCancellationResponse(data, { orderId });
      return;
    }
    let resolvedSymbol = symbol ? normalizeSymbol(symbol) : this.orderSymbols.get(orderId);
    if (!resolvedSymbol) {
      const order = await this.getOrderStatus(orderId);
      resolvedSymbol = order.symbol;
    }
    if (!resolvedSymbol) throw new Error(`Cannot cancel Bitget order ${orderId}: symbol is unknown`);
    await this.assertOrderPermission();
    const data = await this.request<unknown>("POST", "/api/v2/spot/trade/cancel-order", undefined, {
      symbol: resolvedSymbol,
      orderId
    }, true);
    if (!isRecord(data)) throw new Error("Bitget cancel-order response has no data object");
    if (data.orderId != null && String(data.orderId) !== orderId) {
      throw new Error("Bitget cancel-order response returned a different order id");
    }
  }

  async cancelOrderByClientOrderId(clientOrderId: string, symbol: string): Promise<void> {
    const clientOid = normalizeClientOrderId(clientOrderId);
    const normalizedSymbol = normalizeSymbol(symbol);
    await this.assertOrderPermission();
    const path = this.accountMode === "uta" ? "/api/v3/trade/cancel-order" : "/api/v2/spot/trade/cancel-order";
    const data = await this.request<unknown>("POST", path, undefined, this.accountMode === "uta"
      ? { category: "SPOT", clientOid }
      : { symbol: normalizedSymbol, clientOid }, true);
    if (!isRecord(data)) throw new Error("Bitget cancel-order response has no data object");
    if (data.clientOid != null && String(data.clientOid) !== clientOid) {
      throw new Error("Bitget cancel-order response returned a different clientOid");
    }
  }

  private async getOrderInfo(params: URLSearchParams, expected: { orderId?: string; clientOid?: string }): Promise<SpotOrder> {
    const path = this.accountMode === "uta" ? "/api/v3/trade/order-info" : "/api/v2/spot/trade/orderInfo";
    const data = await this.request<unknown>("GET", path, params, undefined, true);
    const rows = Array.isArray(data) ? data : [data];
    const records = rows.filter(isRecord);
    if (!records.length) throw new Error("Bitget order info lookup returned no order");
    const matching = records.filter(record => {
      if (expected.orderId) return String(record.orderId ?? "") === expected.orderId;
      return String(record.clientOid ?? "") === expected.clientOid;
    });
    if (matching.length !== 1) {
      throw new Error(`Bitget order info lookup returned ${matching.length} matching orders`);
    }
    const raw = matching[0]!;
    const symbolName = normalizeSymbol(String(raw.symbol ?? ""));
    const metadata = (await this.getSymbols()).find(symbol => symbol.symbol === symbolName);
    if (!metadata) throw new Error(`Bitget order info returned unknown Spot symbol ${symbolName}`);
    const order = this.accountMode === "uta"
      ? parseUtaSpotOrder(raw, metadata)
      : parseClassicSpotOrder(raw, metadata);
    if (!order.id) throw new Error("Bitget order info returned no order id");
    this.rememberOrder(order.symbol ?? metadata.symbol, order.id, order.clientOrderId ?? "");
    return order;
  }

  private rememberOrder(symbol: string, orderId: string, clientOid: string) {
    if (symbol) {
      this.orderSymbols.set(orderId, symbol);
      if (clientOid) this.orderSymbols.set(`client:${clientOid}`, symbol);
    }
  }

  private ensureOrderBookFeed(symbols: SpotSymbol[]) {
    const signature = `${this.websocketUrl}|${symbols.map(symbol => symbol.symbol).sort().join(",")}`;
    if (this.state.feed && this.state.feedSignature === signature) return this.state.feed;
    this.state.feed?.close();
    this.state.feed = new BitgetOrderBookFeed({
      websocketUrl: this.websocketUrl,
      websocketFactory: this.websocketFactory,
      symbols,
      now: this.now
    });
    this.state.feedSignature = signature;
    this.state.bootstrapPromise = undefined;
    this.state.refreshPromise = undefined;
    return this.state.feed;
  }

  private async bootstrapOrderBooks(feed: BitgetOrderBookFeed, symbols: SpotSymbol[]) {
    feed.start();
    if (feed.hasWebSocket && this.websocketBootstrapMs > 0) {
      await feed.waitForFresh(symbols.map(symbol => symbol.symbol), this.websocketBootstrapMs, this.orderBookMaxAgeMs);
    }
    const missing = symbols.filter(symbol => !feed.isFresh(symbol.symbol, this.now(), this.orderBookMaxAgeMs));
    if (missing.length) await this.refreshOrderBooks(feed, missing);
  }

  private async refreshOrderBooks(feed: BitgetOrderBookFeed, symbols: SpotSymbol[]) {
    const results = await mapWithConcurrency(symbols, 6, async symbol => {
      try {
        const book = await this.fetchOrderBook(symbol);
        feed.acceptRest(book);
        return true;
      } catch {
        // Fail closed: a missing/stale market is excluded, and incomplete triangles
        // are pruned before the snapshot is returned to the engine.
        return false;
      }
    });
    if (!results.some(Boolean) && !feed.snapshot(this.now(), this.orderBookMaxAgeMs).length) {
      throw new Error("Bitget orderbook WebSocket and REST fallback returned no fresh books");
    }
  }

  private async fetchOrderBook(symbol: SpotSymbol): Promise<OrderBook> {
    await this.reserveOrderBookRestSlot();
    const params = new URLSearchParams({ symbol: symbol.symbol, type: "step0", limit: "15" });
    const data = await this.request<unknown>("GET", "/api/v2/spot/market/orderbook", params, undefined, false);
    if (!isRecord(data)) throw new Error(`Bitget orderbook response for ${symbol.symbol} has no data object`);
    return parseOrderBook(symbol, data, this.now);
  }

  private async reserveOrderBookRestSlot() {
    const previous = this.restBookGate;
    let release!: () => void;
    this.restBookGate = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      while (true) {
        const now = this.now();
        this.restBookRequestStarts = this.restBookRequestStarts.filter(start => now - start < 1_000);
        if (this.restBookRequestStarts.length < this.orderBookRestRateLimit) {
          this.restBookRequestStarts.push(now);
          return;
        }
        const wait = Math.max(1, 1_005 - (now - this.restBookRequestStarts[0]!));
        await this.sleep(wait);
      }
    } finally {
      release();
    }
  }

  private async getTickers(): Promise<Ticker[]> {
    const cached = this.state.tickers;
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (this.state.tickersPromise) return this.state.tickersPromise;
    const pending = this.request<unknown>("GET", "/api/v2/spot/market/tickers", undefined, undefined, false)
      .then(data => {
        if (!Array.isArray(data)) throw new Error("Bitget tickers response is not an array");
        const tickers = data.flatMap(item => parseTicker(item));
        this.state.tickers = { value: tickers, expiresAt: this.now() + TICKER_CACHE_MS };
        return tickers;
      })
      .finally(() => { this.state.tickersPromise = undefined; });
    this.state.tickersPromise = pending;
    return pending;
  }

  private async getUtaAccount(): Promise<Json> {
    const cached = this.utaAccount;
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (this.utaAccountPromise) return this.utaAccountPromise;
    const pending = this.request<unknown>("GET", "/api/v3/account/assets", undefined, undefined, true)
      .then(data => {
        if (!isRecord(data)) throw new Error("Bitget UTA account response has no data object");
        this.utaAccount = { value: data, expiresAt: this.now() + 500 };
        return data;
      })
      .finally(() => { this.utaAccountPromise = undefined; });
    this.utaAccountPromise = pending;
    return pending;
  }

  private credentials() {
    const source = this.explicitCredentials ?? {
      apiKey: config.BITGET_API_KEY ?? process.env.BITGET_API_KEY ?? "",
      apiSecret: config.BITGET_API_SECRET ?? process.env.BITGET_API_SECRET ?? process.env.BITGET_SECRET_KEY ?? "",
      passphrase: config.BITGET_API_PASSPHRASE ?? process.env.BITGET_API_PASSPHRASE ?? process.env.BITGET_PASSPHRASE ?? ""
    };
    const apiKey = source.apiKey.trim();
    const apiSecret = source.apiSecret.trim();
    const passphrase = source.passphrase.trim();
    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error(`Bitget API key, secret and passphrase are required for private ${this.accountMode.toUpperCase()} requests`);
    }
    return { apiKey, apiSecret, passphrase };
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    query: URLSearchParams | undefined,
    body: Json | undefined,
    auth: boolean
  ): Promise<T> {
    if (!path.startsWith("/api/")) throw new Error("Invalid Bitget API request path");
    const queryString = query?.toString() ?? "";
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const bodyText = body ? JSON.stringify(body) : "";
    const headers = new Headers({
      accept: "application/json",
      locale: "en-US",
      "user-agent": "TraderBot/BitgetTriArb"
    });
    if (body) headers.set("content-type", "application/json");
    if (auth) {
      this.assertPrivateTransport();
      const { apiKey, apiSecret, passphrase } = this.credentials();
      const timestamp = String(Math.floor(this.now()));
      const prehash = `${timestamp}${method}${requestPath}${bodyText}`;
      headers.set("ACCESS-KEY", apiKey);
      headers.set("ACCESS-SIGN", createHmac("sha256", apiSecret).update(prehash, "utf8").digest("base64"));
      headers.set("ACCESS-TIMESTAMP", timestamp);
      headers.set("ACCESS-PASSPHRASE", passphrase);
      if (this.demoTrading) headers.set("paptrading", "1");
    }

    const response = await this.fetcher(`${this.baseUrl}${requestPath}`, {
      method,
      headers,
      body: bodyText || undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
    const responseText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new BitgetResponseError(`Bitget HTTP ${response.status} returned non-JSON data`, response.status, "NON_JSON", false);
    }
    if (!response.ok) {
      const detail = isRecord(payload) ? `${String(payload.code ?? response.status)} - ${String(payload.msg ?? payload.message ?? "request failed")}` : String(response.status);
      const errorCode = isRecord(payload) ? String(payload.code ?? "") : "";
      throw new BitgetResponseError(
        `Bitget HTTP ${response.status}: ${detail}`,
        response.status,
        errorCode,
        deterministicBitgetRejection(response.status, errorCode)
      );
    }
    if (!isRecord(payload)) throw new BitgetResponseError("Bitget response envelope is invalid", response.status, "INVALID_ENVELOPE", false);
    const code = String(payload.code ?? "");
    if (code !== "00000") {
      throw new BitgetResponseError(
        `Bitget API ${code || "unknown"}: ${String(payload.msg ?? payload.message ?? "request failed")}`,
        response.status,
        code,
        deterministicBitgetRejection(response.status, code)
      );
    }
    if (!("data" in payload)) throw new BitgetResponseError("Bitget response has no data field", response.status, "MISSING_DATA", false);
    return payload.data as T;
  }

  private assertPrivateTransport() {
    if (this.allowPrivateTestTransport) return;
    const url = new URL(this.baseUrl);
    const official = url.protocol === "https:"
      && url.hostname.toLowerCase() === "api.bitget.com"
      && !url.port
      && !url.username
      && !url.password
      && (url.pathname === "/" || url.pathname === "")
      && !url.search
      && !url.hash;
    if (!official) {
      throw new Error("Bitget private requests require the exact official origin https://api.bitget.com");
    }
  }
}

class BitgetResponseError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
    readonly definitive: boolean
  ) {
    super(message);
    this.name = "BitgetResponseError";
  }
}

class BitgetOrderBookFeed {
  private readonly websocketUrl: string;
  private readonly websocketFactory?: WebSocketFactory;
  private readonly symbols: Map<string, SpotSymbol>;
  private readonly now: () => number;
  private readonly books = new Map<string, BookSnapshot>();
  private readonly sockets = new Set<WebSocketLike>();
  private readonly reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly waiters = new Set<() => void>();
  private started = false;
  private stopped = false;

  constructor(input: {
    websocketUrl: string;
    websocketFactory?: WebSocketFactory;
    symbols: SpotSymbol[];
    now: () => number;
  }) {
    this.websocketUrl = input.websocketUrl;
    this.websocketFactory = input.websocketFactory;
    this.symbols = new Map(input.symbols.map(symbol => [symbol.symbol, symbol]));
    this.now = input.now;
  }

  get hasWebSocket() {
    return Boolean(this.websocketFactory);
  }

  start() {
    if (this.started || !this.websocketFactory) return;
    this.started = true;
    const groups = chunk([...this.symbols.keys()].sort(), WS_CHANNELS_PER_CONNECTION);
    for (const group of groups) this.connect(group, 0);
  }

  close() {
    this.stopped = true;
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const socket of this.sockets) {
      try { socket.close(1000, "market set replaced"); } catch { /* no-op */ }
    }
    this.sockets.clear();
    this.resolveWaiters();
  }

  acceptRest(book: OrderBook) {
    if (!this.symbols.has(book.symbol)) return;
    const current = this.books.get(book.symbol);
    if (current && current.book.lastUpdate > book.lastUpdate) return;
    this.books.set(book.symbol, { book: immutableBook(book) });
    this.resolveWaiters();
  }

  isFresh(symbol: string, now: number, maxAgeMs: number) {
    const snapshot = this.books.get(symbol);
    return Boolean(snapshot && validBookAge(snapshot.book.lastUpdate, now, maxAgeMs));
  }

  snapshot(now: number, maxAgeMs: number): OrderBook[] {
    return [...this.books.values()]
      .map(snapshot => snapshot.book)
      .filter(book => validBookAge(book.lastUpdate, now, maxAgeMs))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async waitForFresh(symbols: string[], timeoutMs: number, maxAgeMs: number) {
    const complete = () => symbols.every(symbol => this.isFresh(symbol, this.now(), maxAgeMs));
    if (complete() || timeoutMs <= 0) return;
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (!complete()) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters.delete(finish);
        resolve();
      }, timeoutMs);
      this.waiters.add(finish);
    });
  }

  private connect(symbols: string[], attempt: number) {
    if (this.stopped || !this.websocketFactory) return;
    let socket: WebSocketLike;
    try {
      socket = this.websocketFactory(this.websocketUrl);
    } catch {
      this.scheduleReconnect(symbols, attempt + 1);
      return;
    }
    this.sockets.add(socket);
    let lastPong = this.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let opened = false;

    socket.onopen = () => {
      if (this.stopped) return socket.close(1000, "feed stopped");
      opened = true;
      lastPong = this.now();
      socket.send(JSON.stringify({
        op: "subscribe",
        args: symbols.map(instId => ({ instType: "SPOT", channel: "books15", instId }))
      }));
      heartbeat = setInterval(() => {
        if (this.now() - lastPong > WS_PONG_TIMEOUT_MS) {
          try { socket.close(4000, "pong timeout"); } catch { /* no-op */ }
          return;
        }
        try { socket.send("ping"); } catch { /* close handler reconnects */ }
      }, WS_HEARTBEAT_MS);
      heartbeat.unref?.();
    };
    socket.onmessage = event => {
      if (typeof event.data !== "string") return;
      if (event.data === "pong") {
        lastPong = this.now();
        return;
      }
      this.acceptWebSocketMessage(event.data);
    };
    socket.onerror = () => {
      // The close event is the single reconnect path.
    };
    socket.onclose = () => {
      if (heartbeat) clearInterval(heartbeat);
      this.sockets.delete(socket);
      if (!this.stopped) this.scheduleReconnect(symbols, opened ? 0 : attempt + 1);
    };
  }

  private scheduleReconnect(symbols: string[], attempt: number) {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(timer);
      this.connect(symbols, attempt);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.add(timer);
  }

  private acceptWebSocketMessage(text: string) {
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return; }
    if (!isRecord(payload) || payload.event === "error") return;
    const arg = isRecord(payload.arg) ? payload.arg : undefined;
    const symbolName = arg ? String(arg.instId ?? "").toUpperCase() : "";
    const symbol = this.symbols.get(symbolName);
    if (
      !symbol
      || String(arg?.instType ?? "").toUpperCase() !== "SPOT"
      || String(arg?.channel ?? "") !== "books15"
      || String(payload.action ?? "").toLowerCase() !== "snapshot"
    ) return;
    if (!Array.isArray(payload.data) || payload.data.length !== 1) return;
    const raw = payload.data[0];
    if (!isRecord(raw)) return;
    try {
      if (!validOrderBookChecksum(raw)) return;
      const book = parseOrderBook(symbol, raw, this.now);
      const sequence = optionalSequence(raw.seq);
      if (sequence === undefined) return;
      const current = this.books.get(symbolName);
      if (current && book.lastUpdate < current.book.lastUpdate) return;
      if (sequence !== undefined && current?.sequence !== undefined && sequence <= current.sequence) return;
      this.books.set(symbolName, { book: immutableBook(book), sequence });
      this.resolveWaiters();
    } catch {
      // A malformed or crossed update never replaces the last verified snapshot.
    }
  }

  private resolveWaiters() {
    for (const waiter of [...this.waiters]) waiter();
  }
}

function parseSpotSymbol(value: unknown, index: number): SpotSymbol {
  if (!isRecord(value)) throw new Error(`Bitget symbol at index ${index} is invalid`);
  const symbol = normalizeSymbol(String(value.symbol ?? ""));
  const base = normalizeAsset(String(value.baseCoin ?? ""));
  const quote = normalizeAsset(String(value.quoteCoin ?? ""));
  if (`${base}${quote}` !== symbol) throw new Error(`Bitget symbol ${symbol} does not match ${base}/${quote}`);
  const pricePrecision = precisionInteger(value.pricePrecision, `${symbol} price precision`);
  const quantityPrecision = precisionInteger(value.quantityPrecision, `${symbol} quantity precision`);
  const quotePrecision = precisionInteger(value.quotePrecision, `${symbol} quote precision`);
  return {
    symbol,
    base,
    quote,
    status: String(value.status ?? "").toLowerCase(),
    priceStep: decimalStep(pricePrecision),
    amountStep: decimalStep(quantityPrecision),
    quoteStep: decimalStep(quotePrecision),
    minTradeUsdt: requiredNonNegativeDecimal(value, "minTradeUSDT", `${symbol} minTradeUSDT`),
    takerFeeRate: requiredNonNegativeDecimal(value, "takerFeeRate", `${symbol} taker fee`),
    makerFeeRate: requiredNonNegativeDecimal(value, "makerFeeRate", `${symbol} maker fee`),
    buyLimitPriceRatio: nonNegativeDecimal(value.buyLimitPriceRatio ?? 0, `${symbol} buy price ratio`),
    sellLimitPriceRatio: nonNegativeDecimal(value.sellLimitPriceRatio ?? 0, `${symbol} sell price ratio`),
    raw: value
  };
}

function parseCandle(value: unknown, symbol: string, index: number) {
  if (!Array.isArray(value) || value.length < 6) throw new Error(`Bitget candle ${index} for ${symbol} is invalid`);
  const timestamp = Number(value[0]);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error(`Bitget candle ${index} for ${symbol} has an invalid timestamp`);
  const candle = {
    timestamp,
    open: positiveDecimal(value[1], `${symbol} candle open`),
    high: positiveDecimal(value[2], `${symbol} candle high`),
    low: positiveDecimal(value[3], `${symbol} candle low`),
    close: positiveDecimal(value[4], `${symbol} candle close`),
    volume: nonNegativeDecimal(value[5], `${symbol} candle volume`)
  };
  if (candle.high.lt(Decimal.max(candle.open, candle.close, candle.low))
    || candle.low.gt(Decimal.min(candle.open, candle.close, candle.high))) {
    throw new Error(`Bitget candle ${index} for ${symbol} has inconsistent OHLC values`);
  }
  return candle;
}

function parseWallet(value: unknown, index: number): Wallet {
  if (!isRecord(value)) throw new Error(`Bitget account asset at index ${index} is invalid`);
  const asset = normalizeAsset(String(value.coin ?? ""));
  const available = requiredNonNegativeDecimal(value, "available", `${asset} available balance`);
  const frozen = requiredNonNegativeDecimal(value, "frozen", `${asset} frozen balance`);
  const locked = requiredNonNegativeDecimal(value, "locked", `${asset} locked balance`);
  return { asset, available, blocked: frozen.plus(locked) };
}

function parseUtaWallet(value: unknown, index: number): Wallet {
  if (!isRecord(value)) throw new Error(`Bitget UTA account asset at index ${index} is invalid`);
  const asset = normalizeAsset(String(value.coin ?? ""));
  const available = requiredNonNegativeDecimal(value, "available", `${asset} UTA available balance`);
  const locked = requiredNonNegativeDecimal(value, "locked", `${asset} UTA locked balance`);
  return { asset, available, blocked: locked };
}

function parseTicker(value: unknown): Ticker[] {
  if (!isRecord(value)) return [];
  let symbol: string;
  try { symbol = normalizeSymbol(String(value.symbol ?? "")); } catch { return []; }
  const bid = safePositiveDecimal(value.bidPr);
  const ask = safePositiveDecimal(value.askPr);
  const last = safePositiveDecimal(value.lastPr);
  const bidSize = safePositiveDecimal(value.bidSz);
  const askSize = safePositiveDecimal(value.askSz);
  const timestamp = Number(value.ts);
  if (!bid && !ask) return [];
  return [{
    symbol,
    bid: bid ?? new Decimal(0),
    ask: ask ?? new Decimal(0),
    last: last ?? bid ?? ask!,
    bidSize,
    askSize,
    timestamp: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : undefined
  }];
}

function tickerOrderBook(symbol: SpotSymbol, ticker: Ticker | undefined, snapshotAt: number): OrderBook | undefined {
  if (
    !ticker
    || ticker.bid.lte(0)
    || ticker.ask.lte(0)
    || ticker.bid.gte(ticker.ask)
    || !ticker.bidSize?.gt(0)
    || !ticker.askSize?.gt(0)
    || !Number.isSafeInteger(snapshotAt)
    || snapshotAt <= 0
  ) return undefined;
  return immutableBook({
    symbol: symbol.symbol,
    base: symbol.base,
    quote: symbol.quote,
    bids: [{ price: ticker.bid, amount: ticker.bidSize }],
    asks: [{ price: ticker.ask, amount: ticker.askSize }],
    lastUpdate: snapshotAt
  });
}

function parseOrderBook(symbol: SpotSymbol, value: Json, now: () => number): OrderBook {
  const asks = parseLevels(value.asks, symbol.symbol, "asks").sort((a, b) => a.price.comparedTo(b.price));
  const bids = parseLevels(value.bids, symbol.symbol, "bids").sort((a, b) => b.price.comparedTo(a.price));
  if (!asks.length || !bids.length) throw new Error(`Bitget ${symbol.symbol} orderbook is empty`);
  if (asks.length > 15 || bids.length > 15) throw new Error(`Bitget ${symbol.symbol} orderbook exceeds books15 depth`);
  if (bids[0]!.price.gte(asks[0]!.price)) throw new Error(`Bitget ${symbol.symbol} orderbook is crossed`);
  const lastUpdate = Number(value.ts);
  if (!Number.isSafeInteger(lastUpdate) || lastUpdate <= 0 || lastUpdate > now() + 5_000) {
    throw new Error(`Bitget ${symbol.symbol} orderbook timestamp is invalid`);
  }
  return { symbol: symbol.symbol, base: symbol.base, quote: symbol.quote, asks, bids, lastUpdate };
}

function parseLevels(value: unknown, symbol: string, side: "asks" | "bids") {
  if (!Array.isArray(value)) throw new Error(`Bitget ${symbol} ${side} are invalid`);
  const levels = value.map((level, index) => {
    if (!Array.isArray(level) || level.length < 2) throw new Error(`Bitget ${symbol} ${side}[${index}] is invalid`);
    return {
      price: positiveDecimal(level[0], `${symbol} ${side}[${index}] price`),
      amount: positiveDecimal(level[1], `${symbol} ${side}[${index}] amount`)
    };
  });
  if (firstDuplicate(levels.map(level => level.price.toString()))) {
    throw new Error(`Bitget ${symbol} ${side} contain duplicate prices`);
  }
  return levels;
}

function parseClassicSpotOrder(raw: Json, metadata: SpotSymbol): SpotOrder {
  const id = normalizeLookupId(raw.orderId, "Bitget order id");
  const symbol = normalizeSymbol(String(raw.symbol ?? ""));
  if (symbol !== metadata.symbol) throw new Error("Bitget Classic order metadata symbol mismatch");
  const clientOrderId = raw.clientOid == null || String(raw.clientOid) === "" ? "" : normalizeClientOrderId(String(raw.clientOid));
  if (String(raw.orderType ?? "").toLowerCase() !== "limit") throw new Error(`Bitget Classic order ${id} is not a limit order`);
  const amount = positiveDecimal(raw.size, `${symbol} order size`);
  const matchedAmount = nonNegativeDecimal(raw.baseVolume ?? 0, `${symbol} filled base volume`);
  const totalPrice = nonNegativeDecimal(raw.quoteVolume ?? 0, `${symbol} filled quote volume`);
  const averagePrice = nonNegativeDecimal(raw.priceAvg ?? raw.price ?? 0, `${symbol} average price`);
  const side = normalizeSide(String(raw.side ?? "").toUpperCase());
  const receivedAsset = side === "BUY" ? metadata.base : metadata.quote;
  const status = normalizeOrderStatus(raw.status);
  assertSpotOrderFillIntegrity(id, status, amount, matchedAmount, totalPrice, averagePrice);
  const hasFill = matchedAmount.gt(0);
  if (hasFill && raw.feeDetail == null) throw new Error(`Bitget Classic filled order ${id} has no feeDetail`);
  const feeResult = parseClassicFeeDetail(raw.feeDetail, receivedAsset, hasFill);
  return {
    id,
    symbol,
    clientOrderId,
    side,
    status,
    amount,
    matchedAmount,
    unmatchedAmount: Decimal.max(amount.minus(matchedAmount), 0),
    totalPrice,
    averagePrice,
    fee: feeResult.fee,
    feeAsset: feeResult.asset,
    feeBreakdown: feeResult.breakdown,
    feeDetail: feeResult.detail,
    raw
  };
}

function parseUtaSpotOrder(raw: Json, metadata: SpotSymbol): SpotOrder {
  const id = normalizeLookupId(raw.orderId, "Bitget UTA order id");
  const symbol = normalizeSymbol(String(raw.symbol ?? ""));
  if (symbol !== metadata.symbol) throw new Error("Bitget UTA order metadata symbol mismatch");
  if (String(raw.category ?? "").toUpperCase() !== "SPOT") throw new Error("Bitget UTA order info is not a Spot order");
  const clientOrderId = raw.clientOid == null || String(raw.clientOid) === "" ? "" : normalizeClientOrderId(String(raw.clientOid));
  if (String(raw.orderType ?? "").toLowerCase() !== "limit") throw new Error(`Bitget UTA order ${id} is not a limit order`);
  if (String(raw.timeInForce ?? "").toLowerCase() !== "ioc") throw new Error(`Bitget UTA order ${id} is not IOC`);
  const amount = positiveDecimal(raw.qty, `${symbol} UTA order quantity`);
  const matchedAmount = nonNegativeDecimal(raw.cumExecQty ?? 0, `${symbol} UTA filled base quantity`);
  const totalPrice = nonNegativeDecimal(raw.cumExecValue ?? 0, `${symbol} UTA filled quote value`);
  const averagePrice = nonNegativeDecimal(raw.avgPrice ?? raw.price ?? 0, `${symbol} UTA average price`);
  const side = normalizeSide(String(raw.side ?? "").toUpperCase());
  const receivedAsset = side === "BUY" ? metadata.base : metadata.quote;
  const status = normalizeOrderStatus(raw.orderStatus);
  assertSpotOrderFillIntegrity(id, status, amount, matchedAmount, totalPrice, averagePrice);
  if (matchedAmount.gt(0) && raw.feeDetail == null) throw new Error(`Bitget UTA filled order ${id} has no feeDetail`);
  const feeResult = parseUtaFeeDetail(raw.feeDetail, receivedAsset);
  return {
    id,
    symbol,
    clientOrderId,
    side,
    status,
    amount,
    matchedAmount,
    unmatchedAmount: Decimal.max(amount.minus(matchedAmount), 0),
    totalPrice,
    averagePrice,
    fee: feeResult.fee,
    feeAsset: feeResult.asset,
    feeBreakdown: feeResult.breakdown,
    raw
  };
}

function parseClassicFeeDetail(value: unknown, receivedAsset: string, requireRecognized: boolean) {
  let detail: Json | undefined;
  if (isRecord(value)) detail = value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (isRecord(parsed)) detail = parsed;
    } catch {
      throw new Error("Bitget Classic feeDetail is invalid JSON");
    }
  }
  if (!detail) {
    if (requireRecognized) throw new Error("Bitget Classic filled order has blank feeDetail");
    return feeResult([], receivedAsset, undefined);
  }
  const newFees = isRecord(detail.newFees) ? detail.newFees : undefined;
  if (newFees) {
    for (const field of ["c", "d", "r", "t"] as const) {
      if (!(field in newFees)) throw new Error(`Bitget Classic newFees.${field} is missing`);
    }
    const breakdown: Array<{ asset: string; amount: Decimal }> = [];
    const bgbDebit = feeAmount(newFees.d, "Bitget Classic BGB fee");
    const receivedDebit = feeAmount(newFees.r, `Bitget Classic ${receivedAsset} fee`);
    const couponDebit = feeAmount(newFees.c, "Bitget Classic coupon fee");
    const totalPayable = feeAmount(newFees.t, "Bitget Classic total fee");
    if (bgbDebit.gt(0)) breakdown.push({ asset: "BGB", amount: bgbDebit });
    if (receivedDebit.gt(0)) breakdown.push({ asset: receivedAsset, amount: receivedDebit });
    if (totalPayable.gt(0) && !breakdown.length && couponDebit.lte(0)) {
      throw new Error("Bitget Classic feeDetail has a payable fee but no actual debit component");
    }
    return feeResult(breakdown, receivedAsset, detail);
  }

  const breakdown: Array<{ asset: string; amount: Decimal }> = [];
  let recognized = false;
  for (const entry of Object.values(detail)) {
    if (!isRecord(entry) || !entry.feeCoinCode) continue;
    if (!("totalFee" in entry) && !("totalDeductionFee" in entry)) continue;
    recognized = true;
    const asset = normalizeAsset(String(entry.feeCoinCode));
    const deduction = entry.deduction === true || String(entry.deduction).toLowerCase() === "true";
    const amount = feeAmount(
      deduction ? (entry.totalDeductionFee ?? entry.totalFee) : (entry.totalFee ?? entry.totalDeductionFee),
      `Bitget Classic ${asset} legacy fee`
    );
    if (amount.gt(0)) breakdown.push({ asset, amount });
  }
  if (requireRecognized && !recognized) throw new Error("Bitget Classic filled order has unrecognized feeDetail");
  return feeResult(breakdown, receivedAsset, detail);
}

function parseUtaFeeDetail(value: unknown, receivedAsset: string) {
  if (value == null) return feeResult([], receivedAsset, undefined);
  if (!Array.isArray(value)) throw new Error("Bitget UTA feeDetail is not an array");
  const breakdown = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Bitget UTA feeDetail[${index}] is invalid`);
    const asset = normalizeAsset(String(entry.feeCoin ?? ""));
    const amount = feeAmount(entry.fee, `Bitget UTA ${asset} fee`);
    return { asset, amount };
  }).filter(component => component.amount.gt(0));
  return feeResult(breakdown, receivedAsset, undefined);
}

function feeResult(
  rawBreakdown: Array<{ asset: string; amount: Decimal }>,
  receivedAsset: string,
  detail: Json | undefined
) {
  const amounts = new Map<string, Decimal>();
  for (const component of rawBreakdown) {
    amounts.set(component.asset, (amounts.get(component.asset) ?? new Decimal(0)).plus(component.amount));
  }
  const breakdown = [...amounts].map(([asset, amount]) => ({ asset, amount }));
  const receivedFee = amounts.get(receivedAsset) ?? new Decimal(0);
  return {
    fee: receivedFee,
    asset: breakdown.length === 1 ? breakdown[0]!.asset : (receivedFee.gt(0) ? receivedAsset : undefined),
    breakdown,
    detail
  };
}

function feeAmount(value: unknown, name: string) {
  if (value == null || value === "") return new Decimal(0);
  const parsed = strictDecimal(value, name).abs();
  return parsed;
}

function normalizeOrderStatus(value: unknown) {
  const status = String(value ?? "").toLowerCase();
  if (status === "filled") return "Done";
  if (status === "cancelled" || status === "canceled") return "Canceled";
  if (status === "partially_filled") return "PartiallyFilled";
  if (status === "live" || status === "new") return "Active";
  if (status === "rejected") return "Rejected";
  if (!status) throw new Error("Bitget order status is missing");
  return String(value);
}

function assertSpotOrderFillIntegrity(
  id: string,
  status: string,
  amount: Decimal,
  matchedAmount: Decimal,
  totalPrice: Decimal,
  averagePrice: Decimal
) {
  if (matchedAmount.gt(amount)) throw new Error(`Bitget order ${id} filled quantity exceeds its order quantity`);
  if (matchedAmount.gt(0) && (totalPrice.lte(0) || averagePrice.lte(0))) {
    throw new Error(`Bitget order ${id} has a positive fill with no positive quote value/average price`);
  }
  if (status === "Done" && !matchedAmount.eq(amount)) {
    throw new Error(`Bitget filled order ${id} does not report its full base quantity`);
  }
}

function triangleRelevantSymbols(symbols: SpotSymbol[], anchor: string) {
  const online = symbols.filter(symbol => symbol.status === "online" && symbol.base !== symbol.quote);
  const directNeighbors = new Set<string>();
  for (const symbol of online) {
    if (symbol.base === anchor) directNeighbors.add(symbol.quote);
    if (symbol.quote === anchor) directNeighbors.add(symbol.base);
  }
  const triangleAssets = new Set<string>();
  const crossSymbols = new Set<string>();
  for (const symbol of online) {
    if (symbol.base === anchor || symbol.quote === anchor) continue;
    if (!directNeighbors.has(symbol.base) || !directNeighbors.has(symbol.quote)) continue;
    triangleAssets.add(symbol.base);
    triangleAssets.add(symbol.quote);
    crossSymbols.add(symbol.symbol);
  }
  return online
    .filter(symbol => crossSymbols.has(symbol.symbol)
      || (symbol.base === anchor && triangleAssets.has(symbol.quote))
      || (symbol.quote === anchor && triangleAssets.has(symbol.base)))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function syntheticSpotSymbol(book: OrderBook): SpotSymbol {
  return {
    symbol: book.symbol,
    base: book.base,
    quote: book.quote,
    status: "online",
    priceStep: new Decimal(1),
    amountStep: new Decimal(1),
    quoteStep: new Decimal(1),
    minTradeUsdt: new Decimal(0),
    takerFeeRate: new Decimal(0),
    makerFeeRate: new Decimal(0),
    buyLimitPriceRatio: new Decimal(0),
    sellLimitPriceRatio: new Decimal(0),
    raw: {}
  };
}

function buildUsdtValuationRates(symbols: SpotSymbol[], tickers: Ticker[]) {
  const symbolMap = new Map(symbols.filter(symbol => symbol.status === "online").map(symbol => [symbol.symbol, symbol]));
  const edges = new Map<string, Array<{ to: string; rate: Decimal }>>();
  const add = (from: string, to: string, rate: Decimal) => {
    const values = edges.get(from) ?? [];
    values.push({ to, rate });
    edges.set(from, values);
  };
  for (const ticker of tickers) {
    const symbol = symbolMap.get(ticker.symbol);
    if (!symbol) continue;
    if (ticker.bid.gt(0)) add(symbol.base, symbol.quote, ticker.bid);
    if (ticker.ask.gt(0)) add(symbol.quote, symbol.base, new Decimal(1).div(ticker.ask));
  }
  return edges;
}

function directUsdtRate(asset: string, symbols: SpotSymbol[], tickers: Ticker[]) {
  if (asset === "USDT") return new Decimal(1);
  const symbolMap = new Map(symbols.filter(symbol => symbol.status === "online").map(symbol => [symbol.symbol, symbol]));
  for (const ticker of tickers) {
    const symbol = symbolMap.get(ticker.symbol);
    if (!symbol) continue;
    if (symbol.base === asset && symbol.quote === "USDT" && ticker.bid.gt(0)) return ticker.bid;
    if (symbol.base === "USDT" && symbol.quote === asset && ticker.ask.gt(0)) return new Decimal(1).div(ticker.ask);
  }
  return undefined;
}

function assertCancellationResponse(data: unknown, expected: { orderId?: string; clientOid?: string }) {
  if (!isRecord(data)) throw new Error("Bitget cancel-order response has no data object");
  if (expected.orderId && data.orderId != null && String(data.orderId) !== expected.orderId) {
    throw new Error("Bitget cancel-order response returned a different order id");
  }
  if (expected.clientOid && data.clientOid != null && String(data.clientOid) !== expected.clientOid) {
    throw new Error("Bitget cancel-order response returned a different clientOid");
  }
}

function deterministicBitgetRejection(httpStatus: number, code: string) {
  if (httpStatus >= 500 || httpStatus === 408 || httpStatus === 425 || httpStatus === 429) return false;
  // Forward-compatible default is ambiguous. Only documented validation,
  // permission, balance, precision, risk, and market-state rejections that
  // happen before acceptance may suppress clientOid reconciliation.
  const deterministicCodes = new Set([
    "00171", "00172", "01001", "01002", "01003", "22004",
    "25100", "25101", "25102", "25202", "25205", "25206", "25207", "25208", "25209", "25210", "25211", "25213", "25214", "25215",
    "40001", "40002", "40003", "40005", "40006", "40007", "40008", "40009", "40011", "40012", "40013", "40014", "40016", "40017", "40018", "40019", "40020", "40022", "40023", "40024", "40025", "40026", "40031", "40034", "40035", "40036", "40037", "40038", "40040", "40041", "40053", "40057", "40064", "40072", "40078", "40079",
    "40102", "40199", "40304", "40305", "40402",
    "40706", "40707", "40721", "40723", "40724", "40734", "40748", "40752", "40754", "40755", "40756", "40757", "40760", "40761", "40762", "40764", "40765", "40766", "40798",
    "40800", "40913", "40918",
    "43010", "43011", "43012", "43027", "43028", "43037", "43038", "43039", "43040", "43041", "43042",
    "43111", "43122", "43128", "43132",
    "45002", "45003", "45004", "45005", "45006", "45007", "45008", "45009", "45017", "45018", "45019", "45020", "45021", "45035", "45043",
    "50016", "50017", "50018", "50019", "50020", "50021", "50022", "50023", "50024", "50025", "50026", "50027", "50028", "50029", "50030", "50032", "50035", "50036", "50037", "50038", "50039", "50045", "50046", "50047", "50048", "50061", "50063", "50064", "50065", "50068", "50081"
  ]);
  return deterministicCodes.has(code);
}

function bestConversionRate(
  from: string,
  target: string,
  edges: Map<string, Array<{ to: string; rate: Decimal }>>,
  maxHops: number
) {
  let best: Decimal | undefined;
  const walk = (asset: string, rate: Decimal, hops: number, visited: Set<string>) => {
    if (asset === target) {
      if (!best || rate.gt(best)) best = rate;
      return;
    }
    if (hops >= maxHops) return;
    for (const edge of edges.get(asset) ?? []) {
      if (visited.has(edge.to)) continue;
      const nextVisited = new Set(visited);
      nextVisited.add(edge.to);
      walk(edge.to, rate.mul(edge.rate), hops + 1, nextVisited);
    }
  };
  walk(from, new Decimal(1), 0, new Set([from]));
  return best;
}

function immutableBook(book: OrderBook): OrderBook {
  const bids = Object.freeze(book.bids.map(level => Object.freeze({ price: new Decimal(level.price), amount: new Decimal(level.amount) })));
  const asks = Object.freeze(book.asks.map(level => Object.freeze({ price: new Decimal(level.price), amount: new Decimal(level.amount) })));
  return Object.freeze({ ...book, bids, asks }) as unknown as OrderBook;
}

function validBookAge(timestamp: number, now: number, maxAgeMs: number) {
  return Number.isFinite(timestamp) && timestamp <= now + 1_000 && now - timestamp <= maxAgeMs;
}

function optionalSequence(value: unknown) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function validOrderBookChecksum(value: Json) {
  // Bitget's current books15 Spot stream can omit `checksum` while still
  // sending a full snapshot with seq/pseq. books15 never sends incremental
  // updates, so a non-negative seq plus pseq=0 is the integrity/ordering fence
  // for that documented full-snapshot form. If checksum is present, verify it.
  if (value.checksum == null || value.checksum === "") {
    return optionalSequence(value.seq) !== undefined
      && optionalSequence(value.pseq) === 0;
  }
  const checksum = Number(value.checksum);
  if (!Number.isSafeInteger(checksum) || checksum < -2_147_483_648 || checksum > 2_147_483_647) return false;
  // Bitget currently sends 0 for books15 snapshots when checksum verification
  // is not enabled for that push.
  if (checksum === 0) return true;
  const bids = rawChecksumLevels(value.bids);
  const asks = rawChecksumLevels(value.asks);
  if (!bids || !asks) return false;
  const fields: string[] = [];
  for (let index = 0; index < Math.max(bids.length, asks.length, 25) && index < 25; index += 1) {
    const bid = bids[index];
    const ask = asks[index];
    if (bid) fields.push(bid[0], bid[1]);
    if (ask) fields.push(ask[0], ask[1]);
  }
  return crc32Signed(fields.join(":")) === checksum;
}

function rawChecksumLevels(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Array<[string, string]> = [];
  for (const level of value) {
    if (!Array.isArray(level) || level.length < 2 || typeof level[0] !== "string" || typeof level[1] !== "string") return undefined;
    result.push([level[0], level[1]]);
  }
  return result;
}

function crc32Signed(value: string) {
  let crc = 0xffffffff;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) | 0;
}

function candleGranularity(resolution: string) {
  const key = resolution.trim();
  const values: Record<string, string> = {
    "1": "1min", "1m": "1min", "1min": "1min",
    "3": "3min", "3m": "3min", "3min": "3min",
    "5": "5min", "5m": "5min", "5min": "5min",
    "15": "15min", "15m": "15min", "15min": "15min",
    "30": "30min", "30m": "30min", "30min": "30min",
    "60": "1h", "1h": "1h", "1H": "1h",
    "240": "4h", "4h": "4h", "4H": "4h",
    "360": "6h", "6h": "6h", "6H": "6h",
    "720": "12h", "12h": "12h", "12H": "12h",
    D: "1day", "1D": "1day", "1d": "1day", "1day": "1day",
    W: "1week", "1W": "1week", "1w": "1week", "1week": "1week",
    M: "1M", "1M": "1M"
  };
  const granularity = values[key];
  if (!granularity) throw new Error(`Unsupported Bitget candle resolution ${resolution}`);
  return granularity;
}

function normalizeHttpBase(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Bitget REST URL must use HTTP(S)");
  return url.toString().replace(/\/$/, "");
}

function normalizeWebSocketUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("Bitget WebSocket URL must use WS(S)");
  return url.toString().replace(/\/$/, "");
}

function normalizeAsset(value: string) {
  const asset = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(asset)) throw new Error(`Invalid Bitget asset ${value}`);
  return asset;
}

function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,40}$/.test(symbol)) throw new Error(`Invalid Bitget symbol ${value}`);
  return symbol;
}

function normalizeSide(value: string): Side {
  const side = value.trim().toUpperCase();
  if (side !== "BUY" && side !== "SELL") throw new Error(`Invalid Bitget order side ${value}`);
  return side;
}

function normalizeClientOrderId(value: string) {
  const clientOid = value.trim();
  if (!/^[.A-Za-z0-9_:\/-]{1,32}$/.test(clientOid)) throw new Error("Invalid Bitget clientOid");
  return clientOid;
}

function normalizeLookupId(value: unknown, name: string) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid ${name}`);
  return id;
}

function positiveDecimal(value: unknown, name: string) {
  const parsed = strictDecimal(value, name);
  if (parsed.lte(0)) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonNegativeDecimal(value: unknown, name: string) {
  const parsed = strictDecimal(value, name);
  if (parsed.lt(0)) throw new Error(`${name} must not be negative`);
  return parsed;
}

function requiredNonNegativeDecimal(record: Json, key: string, name: string) {
  if (!(key in record) || record[key] == null || record[key] === "") throw new Error(`${name} is missing`);
  return nonNegativeDecimal(record[key], name);
}

function strictDecimal(value: unknown, name: string) {
  try {
    const parsed = new Decimal(value as Decimal.Value);
    if (!parsed.isFinite()) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} is not a finite decimal`);
  }
}

function safeDecimal(value: unknown) {
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safePositiveDecimal(value: unknown) {
  const parsed = safeDecimal(value);
  return parsed?.gt(0) ? parsed : undefined;
}

function precisionInteger(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 30) throw new Error(`${name} is invalid`);
  return parsed;
}

function decimalStep(precision: number) {
  return new Decimal(10).pow(-precision);
}

function assertStepAligned(value: Decimal, step: Decimal, name: string) {
  if (!value.div(step).isInteger()) throw new Error(`Order rejected: ${name} is not aligned to step ${step.toString()}`);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function firstDuplicate(values: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultWebSocketFactory(): WebSocketFactory | undefined {
  if (typeof globalThis.WebSocket !== "function") return undefined;
  return url => new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

function chunk<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, operation: (value: T) => Promise<R>) {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      result[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}
