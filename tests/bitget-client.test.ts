import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { BitgetClient, type BitgetClientOptions } from "@/lib/exchanges/bitget";

const NOW = 1_800_000_000_000;
const credentials = { apiKey: "unit-key", apiSecret: "unit-secret", passphrase: "unit-pass" };

type FetchCall = { url: URL; init: RequestInit };

function envelope(data: unknown, input: { code?: string; msg?: string; status?: number } = {}) {
  return new Response(JSON.stringify({
    code: input.code ?? "00000",
    msg: input.msg ?? "success",
    requestTime: NOW,
    data
  }), {
    status: input.status ?? 200,
    headers: { "content-type": "application/json" }
  });
}

function makeFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

function spotSymbol(
  base: string,
  quote: string,
  input: Partial<Record<string, unknown>> = {}
) {
  return {
    symbol: `${base}${quote}`,
    baseCoin: base,
    quoteCoin: quote,
    minTradeAmount: "0",
    maxTradeAmount: "999999999",
    takerFeeRate: "0.002",
    makerFeeRate: "0.001",
    pricePrecision: "2",
    quantityPrecision: "4",
    quotePrecision: "6",
    status: "online",
    minTradeUSDT: "1",
    buyLimitPriceRatio: "0.05",
    sellLimitPriceRatio: "0.05",
    ...input
  };
}

function bookData(ts = NOW, bid = "100", ask = "101") {
  return {
    bids: [[bid, "5"], [new Decimal(bid).minus(1).toString(), "10"]],
    asks: [[ask, "6"], [new Decimal(ask).plus(1).toString(), "11"]],
    ts: String(ts)
  };
}

function clientOptions(fetcher: typeof fetch, input: Partial<BitgetClientOptions> = {}): BitgetClientOptions {
  return {
    baseUrl: "https://api.bitget.com",
    fetch: fetcher,
    credentials,
    accountMode: "classic",
    now: () => NOW,
    disableWebSocket: true,
    assertOrderPermission: async () => true,
    sharedMarketData: false,
    ...input
  };
}

function bodyOf(call: FetchCall) {
  return JSON.parse(String(call.init.body ?? "{}")) as Record<string, unknown>;
}

describe("Bitget public Classic V2 market adapter", () => {
  test("maps official symbol rules, candle granularity, and ascending candles", async () => {
    const symbols = [
      spotSymbol("BTC", "USDT", { pricePrecision: "1", quantityPrecision: "6", minTradeUSDT: "5", takerFeeRate: "0.0015" }),
      spotSymbol("ETH", "USDT", { minTradeUSDT: "2" }),
      spotSymbol("ETH", "BTC", { minTradeUSDT: "3" })
    ];
    const { fetcher, calls } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/candles")) {
        expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
        expect(url.searchParams.get("granularity")).toBe("1h");
        expect(url.searchParams.get("limit")).toBe("20");
        return envelope([
          [String(NOW), "101", "103", "100", "102", "12"],
          [String(NOW - 60_000), "99", "102", "98", "101", "10"]
        ]);
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher));

    const options = await client.getMarketOptions();
    expect(options.amountSteps.BTCUSDT?.toString()).toBe("0.000001");
    expect(options.priceSteps.BTCUSDT?.toString()).toBe("0.1");
    expect(options.minTradeUsdtBySymbol?.BTCUSDT?.toString()).toBe("5");
    expect(options.minOrderQuoteBySymbol?.BTCUSDT?.toString()).toBe("5");
    expect(options.minOrderQuoteBySymbol?.ETHBTC).toBeUndefined();
    expect(options.takerFeeBpsBySymbol?.BTCUSDT?.toString()).toBe("15");
    expect(options.minOrderUsdt.toString()).toBe("5");

    const candles = await client.getCandles("btcusdt", "60", 2);
    expect(candles.timestamps).toEqual([(NOW - 60_000) / 1_000, NOW / 1_000]);
    expect(candles.close.map(value => value.toString())).toEqual(["101", "102"]);
    expect(calls.filter(call => call.url.pathname.endsWith("/symbols"))).toHaveLength(1);
  });

  test("REST fallback returns only complete online USDT triangles and immutable books", async () => {
    const symbols = [
      spotSymbol("BTC", "USDT"),
      spotSymbol("ETH", "USDT"),
      spotSymbol("ETH", "BTC"),
      spotSymbol("DOGE", "USDT"),
      spotSymbol("OFF", "USDT", { status: "offline" })
    ];
    const requestedBooks: string[] = [];
    const { fetcher } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/orderbook")) {
        requestedBooks.push(url.searchParams.get("symbol")!);
        expect(url.searchParams.get("limit")).toBe("15");
        return envelope(bookData());
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher));

    const books = await client.getAllOrderBooks();
    expect(books.map(book => book.symbol)).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
    expect(requestedBooks.sort()).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
    expect(Object.isFrozen(books[0])).toBe(true);
    expect(Object.isFrozen(books[0]!.asks)).toBe(true);
    expect(Object.isFrozen(books[0]!.asks[0])).toBe(true);
  });

  test("builds a coherent full-market Triangle discovery snapshot from all tickers", async () => {
    const symbols = [
      spotSymbol("BTC", "USDT"),
      spotSymbol("ETH", "USDT"),
      spotSymbol("ETH", "BTC"),
      spotSymbol("DOGE", "USDT")
    ];
    const tickers = [
      { symbol: "BTCUSDT", bidPr: "50000", askPr: "50001", lastPr: "50000", bidSz: "3", askSz: "4", ts: String(NOW - 60_000) },
      { symbol: "ETHUSDT", bidPr: "3000", askPr: "3001", lastPr: "3000", bidSz: "30", askSz: "40", ts: String(NOW - 30_000) },
      { symbol: "ETHBTC", bidPr: "0.06", askPr: "0.061", lastPr: "0.06", bidSz: "50", askSz: "60", ts: String(NOW - 10_000) },
      { symbol: "DOGEUSDT", bidPr: "0.1", askPr: "0.11", lastPr: "0.1", bidSz: "100", askSz: "100", ts: String(NOW) }
    ];
    const { fetcher, calls } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/tickers")) return envelope(tickers);
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher));

    const books = await client.getTriangleScanOrderBooks();
    expect(books.map(book => book.symbol)).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
    expect(new Set(books.map(book => book.lastUpdate))).toEqual(new Set([NOW]));
    expect(books.every(book => book.bids.length === 1 && book.asks.length === 1)).toBe(true);
    expect(calls.filter(call => call.url.pathname.endsWith("/orderbook"))).toHaveLength(0);
  });

  test("fails closed when fallback cannot construct a complete non-crossed triangle", async () => {
    const symbols = [spotSymbol("BTC", "USDT"), spotSymbol("ETH", "USDT"), spotSymbol("ETH", "BTC")];
    const { fetcher } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/orderbook")) {
        const symbol = url.searchParams.get("symbol");
        return envelope(symbol === "ETHBTC" ? bookData(NOW, "102", "101") : bookData());
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher));
    await expect(client.getAllOrderBooks()).rejects.toThrow("no complete fresh USDT triangle");
  });

  test("rejects symbol metadata that omits an official fee rate", async () => {
    const malformed = spotSymbol("BTC", "USDT") as Record<string, unknown>;
    delete malformed.takerFeeRate;
    const { fetcher } = makeFetch(() => envelope([malformed]));
    const client = new BitgetClient(clientOptions(fetcher));
    await expect(client.getMarketOptions()).rejects.toThrow("BTCUSDT taker fee is missing");
  });
});

class FakeWebSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly subscriptions: string[] = [];

  constructor(readonly url: string, private readonly timestamp: () => number) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string) {
    if (data === "ping") return this.onmessage?.({ data: "pong" });
    const payload = JSON.parse(data) as { op: string; args: Array<{ instId: string }> };
    expect(payload.op).toBe("subscribe");
    for (const arg of payload.args) {
      this.subscriptions.push(arg.instId);
      this.emitBook(arg.instId, "100", "101", 1);
    }
  }

  emitBook(symbol: string, bid: string, ask: string, seq: number, action = "snapshot", timestamp = this.timestamp(), pseq = "0") {
    this.onmessage?.({
      data: JSON.stringify({
        action,
        arg: { instType: "SPOT", channel: "books15", instId: symbol },
        // Mirrors Bitget's current books15 payload: full snapshots can omit
        // checksum and carry seq/pseq instead.
        data: [{ ...bookData(timestamp, bid, ask), seq, pseq }]
      })
    });
  }

  close() {
    this.readyState = 3;
  }
}

describe("Bitget books15 WebSocket feed", () => {
  test("subscribes only 101 triangle markets in three <=45 channel shards and replaces snapshots immutably", async () => {
    const assets = Array.from({ length: 51 }, (_, index) => `C${String(index).padStart(2, "0")}`);
    const symbols = [
      ...assets.map(asset => spotSymbol(asset, "USDT")),
      ...assets.slice(1).map(asset => spotSymbol(asset, assets[0]!)),
      spotSymbol("DOGE", "USDT")
    ];
    let now = NOW;
    const { fetcher, calls } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      throw new Error(`REST orderbook fallback was not expected: ${url}`);
    });
    const sockets: FakeWebSocket[] = [];
    const client = new BitgetClient(clientOptions(fetcher, {
      disableWebSocket: false,
      now: () => now,
      websocketBootstrapMs: 500,
      webSocketFactory: url => {
        const socket = new FakeWebSocket(url, () => now);
        sockets.push(socket);
        return socket;
      }
    }));

    const first = await client.getAllOrderBooks();
    expect(first).toHaveLength(101);
    expect(sockets).toHaveLength(3);
    expect(sockets.every(socket => socket.subscriptions.length <= 45)).toBe(true);
    expect(sockets.reduce((sum, socket) => sum + socket.subscriptions.length, 0)).toBe(101);
    expect(calls.filter(call => call.url.pathname.endsWith("/orderbook"))).toHaveLength(0);

    const target = first[0]!.symbol;
    const originalAsk = first[0]!.asks[0]!.price.toString();
    now += 1;
    const socket = sockets.find(item => item.subscriptions.includes(target))!;
    socket.emitBook(target, "200", "201", 2);
    const second = await client.getAllOrderBooks();
    expect(first[0]!.asks[0]!.price.toString()).toBe(originalAsk);
    expect(second.find(book => book.symbol === target)!.asks[0]!.price.toString()).toBe("201");

    now += 1;
    socket.emitBook(target, "250", "251", 3, "snapshot", now, "1");
    const rejectedBrokenSequence = await client.getAllOrderBooks();
    expect(rejectedBrokenSequence.find(book => book.symbol === target)!.asks[0]!.price.toString()).toBe("201");

    now += 1;
    socket.emitBook(target, "300", "301", 4, "update");
    const third = await client.getAllOrderBooks();
    expect(third.find(book => book.symbol === target)!.asks[0]!.price.toString()).toBe("201");
  });

  test("does not let a late older WebSocket snapshot overwrite a newer REST fallback", async () => {
    const symbols = [spotSymbol("BTC", "USDT"), spotSymbol("ETH", "USDT"), spotSymbol("ETH", "BTC")];
    let now = NOW;
    const { fetcher } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/orderbook")) return envelope(bookData(now, "150", "151"));
      throw new Error(`Unexpected URL ${url}`);
    });
    const sockets: FakeWebSocket[] = [];
    const client = new BitgetClient(clientOptions(fetcher, {
      disableWebSocket: false,
      now: () => now,
      websocketBootstrapMs: 500,
      orderBookMaxAgeMs: 500,
      webSocketFactory: url => {
        const socket = new FakeWebSocket(url, () => now);
        sockets.push(socket);
        return socket;
      }
    }));

    await client.getAllOrderBooks();
    now += 1_000;
    const afterRest = await client.getAllOrderBooks();
    expect(afterRest.find(book => book.symbol === "BTCUSDT")!.asks[0]!.price.toString()).toBe("151");

    const socket = sockets.find(item => item.subscriptions.includes("BTCUSDT"))!;
    socket.emitBook("BTCUSDT", "200", "201", 2, "snapshot", now - 100);
    const afterLateWebSocket = await client.getAllOrderBooks();
    expect(afterLateWebSocket.find(book => book.symbol === "BTCUSDT")!.asks[0]!.price.toString()).toBe("151");
  });
});

describe("Bitget Classic private adapter", () => {
  test("signs exact query, sends demo header, and maps Spot balances/portfolio", async () => {
    const symbols = [spotSymbol("BTC", "USDT")];
    const assets = [
      { coin: "USDT", available: "100", frozen: "2", locked: "3" },
      { coin: "BTC", available: "0.1", frozen: "0", locked: "0" }
    ];
    const { fetcher, calls } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/assets")) return envelope(assets);
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/tickers")) return envelope([
        { symbol: "BTCUSDT", bidPr: "50000", askPr: "50010", lastPr: "50005" }
      ]);
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher, { demoTrading: true }));

    const wallets = await client.getWallets();
    expect(wallets.find(wallet => wallet.asset === "USDT")?.blocked.toString()).toBe("5");
    const portfolio = await client.getSpotPortfolioSummary();
    expect(portfolio.availableUsdt.toString()).toBe("100");
    expect(portfolio.blockedUsdt.toString()).toBe("5");
    expect(portfolio.totalEstimatedUsdt.toString()).toBe("5105");

    const privateCall = calls.find(call => call.url.pathname.endsWith("/assets"))!;
    const headers = new Headers(privateCall.init.headers);
    const requestPath = `${privateCall.url.pathname}${privateCall.url.search}`;
    const expected = createHmac("sha256", credentials.apiSecret)
      .update(`${NOW}GET${requestPath}`)
      .digest("base64");
    expect(headers.get("ACCESS-KEY")).toBe(credentials.apiKey);
    expect(headers.get("ACCESS-PASSPHRASE")).toBe(credentials.passphrase);
    expect(headers.get("ACCESS-TIMESTAMP")).toBe(String(NOW));
    expect(headers.get("ACCESS-SIGN")).toBe(expected);
    expect(headers.get("paptrading")).toBe("1");
    expect(privateCall.init.redirect).toBe("error");
  });

  test("places protected IOC limit, reconciles fees by actual asset, and cancels with cached symbol", async () => {
    const symbols = [spotSymbol("BTC", "USDT", { quantityPrecision: "4", pricePrecision: "2", minTradeUSDT: "1" })];
    let permissions = 0;
    const { fetcher, calls } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/place-order")) return envelope({ orderId: "9001", clientOid: "tri-unit-1" });
      if (url.pathname.endsWith("/orderInfo")) return envelope([{
        symbol: "BTCUSDT",
        orderId: "9001",
        clientOid: "tri-unit-1",
        price: "50000",
        size: "0.0100",
        orderType: "limit",
        side: "buy",
        status: "filled",
        priceAvg: "49999",
        baseVolume: "0.0100",
        quoteVolume: "499.99",
        feeDetail: JSON.stringify({
          newFees: { c: "0", d: "-0.02", r: "-0.00001", t: "-0.00002", deduction: true }
        })
      }]);
      if (url.pathname.endsWith("/cancel-order")) return envelope({ orderId: "9001", clientOid: "tri-unit-1" });
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher, {
      assertOrderPermission: async () => { permissions += 1; }
    }));

    const submitted = await client.placeMarketOrder({
      side: "BUY",
      base: "BTC",
      quote: "USDT",
      amountBase: new Decimal("0.01"),
      expectedPrice: new Decimal("50000"),
      clientOrderId: "tri-unit-1"
    });
    expect(submitted.id).toBe("9001");
    const placeCall = calls.find(call => call.url.pathname.endsWith("/place-order"))!;
    expect(bodyOf(placeCall)).toEqual({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "limit",
      force: "ioc",
      price: "50000",
      size: "0.01",
      clientOid: "tri-unit-1"
    });
    const bodyText = String(placeCall.init.body);
    const expectedSignature = createHmac("sha256", credentials.apiSecret)
      .update(`${NOW}POST/api/v2/spot/trade/place-order${bodyText}`)
      .digest("base64");
    expect(new Headers(placeCall.init.headers).get("ACCESS-SIGN")).toBe(expectedSignature);

    const filled = await client.getOrderStatus("9001");
    expect(filled.status).toBe("Done");
    expect(filled.fee.toString()).toBe("0.00001");
    expect(filled.feeAsset).toBe("BTC");
    expect(filled.feeBreakdown?.map(item => [item.asset, item.amount.toString()])).toEqual([
      ["BGB", "0.02"],
      ["BTC", "0.00001"]
    ]);

    await client.cancelOrder("9001");
    expect(bodyOf(calls.find(call => call.url.pathname.endsWith("/cancel-order"))!)).toEqual({
      symbol: "BTCUSDT",
      orderId: "9001"
    });
    expect(permissions).toBe(2);
  });

  test("validates cross-quote minTradeUSDT with a direct quote/USDT bid", async () => {
    const symbols = [
      spotSymbol("ETH", "BTC", { minTradeUSDT: "10", pricePrecision: "4", quantityPrecision: "4" }),
      spotSymbol("BTC", "USDT")
    ];
    const { fetcher, calls } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/tickers")) return envelope([
        { symbol: "BTCUSDT", bidPr: "50000", askPr: "50010", lastPr: "50000" }
      ]);
      if (url.pathname.endsWith("/place-order")) return envelope({ orderId: "1", clientOid: "cross-min" });
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher));
    await expect(client.placeMarketOrder({
      side: "BUY", base: "ETH", quote: "BTC",
      amountBase: new Decimal("0.01"), expectedPrice: new Decimal("0.01"), clientOrderId: "cross-min"
    })).rejects.toThrow("estimated notional 5 USDT is below 10 USDT");
    expect(calls.some(call => call.url.pathname.endsWith("/place-order"))).toBe(false);
  });

  test("keeps documented timeout/system responses ambiguous but prefixes deterministic rejections", async () => {
    const symbols = [spotSymbol("BTC", "USDT")];
    let code = "40010";
    const { fetcher } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/place-order")) return envelope(null, { code, msg: code === "40010" ? "Request timed out" : "Insufficient balance" });
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher));
    const input = {
      side: "BUY" as const, base: "BTC", quote: "USDT",
      amountBase: new Decimal("1"), expectedPrice: new Decimal("100"), clientOrderId: "ambiguous-1"
    };
    let timeoutMessage = "";
    try { await client.placeMarketOrder(input); } catch (error) { timeoutMessage = String((error as Error).message); }
    expect(timeoutMessage).toContain("40010");
    expect(timeoutMessage.startsWith("Order rejected:")).toBe(false);

    code = "43012";
    await expect(client.placeMarketOrder({ ...input, clientOrderId: "rejected-1" })).rejects.toThrow(/^Order rejected:/);
  });

  test("rejects blank fee details and incoherent filled quantities/values", async () => {
    const symbols = [spotSymbol("BTC", "USDT")];
    let order = {
      symbol: "BTCUSDT", orderId: "77", clientOid: "integrity-1", orderType: "limit", side: "buy",
      status: "partially_filled", price: "100", size: "1", priceAvg: "100",
      baseVolume: "2", quoteVolume: "200", feeDetail: "{}"
    };
    const { fetcher } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/orderInfo")) return envelope([order]);
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher));
    await expect(client.getOrderStatus("77")).rejects.toThrow("filled quantity exceeds");

    order = { ...order, baseVolume: "0.5", quoteVolume: "0", priceAvg: "0" };
    await expect(client.getOrderStatus("77")).rejects.toThrow("positive fill with no positive quote value");

    order = { ...order, status: "filled", baseVolume: "1", quoteVolume: "100", priceAvg: "100", feeDetail: "" };
    await expect(client.getOrderStatus("77")).rejects.toThrow("blank feeDetail");
  });
});

describe("Bitget UTA V3 private adapter", () => {
  test("uses UTA assets/equity and UTA Spot order/status/cancel contracts", async () => {
    const symbols = [spotSymbol("BTC", "USDT")];
    let permissions = 0;
    const { fetcher, calls } = makeFetch(({ url }) => {
      if (url.pathname.endsWith("/api/v3/account/assets")) return envelope({
        accountEquity: "120.25",
        usdtEquity: "120.5",
        assets: [
          { coin: "USDT", available: "90", locked: "5", balance: "95", equity: "95" },
          { coin: "BTC", available: "0.0005", locked: "0", balance: "0.0005", equity: "0.0005" }
        ]
      });
      if (url.pathname.endsWith("/symbols")) return envelope(symbols);
      if (url.pathname.endsWith("/api/v3/trade/place-order")) return envelope({ orderId: "uta-9001", clientOid: "uta-unit-1" });
      if (url.pathname.endsWith("/api/v3/trade/order-info")) return envelope({
        orderId: "uta-9001",
        clientOid: "uta-unit-1",
        category: "SPOT",
        symbol: "BTCUSDT",
        price: "50000",
        qty: "0.01",
        orderType: "limit",
        timeInForce: "ioc",
        cumExecQty: "0.01",
        cumExecValue: "500",
        avgPrice: "50000",
        orderStatus: "filled",
        side: "sell",
        feeDetail: [
          { feeCoin: "USDT", fee: "-0.25" },
          { feeCoin: "BGB", fee: "-0.01" }
        ]
      });
      if (url.pathname.endsWith("/api/v3/trade/cancel-order")) return envelope({ orderId: "uta-9001", clientOid: "uta-unit-1" });
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BitgetClient(clientOptions(fetcher, {
      accountMode: "uta",
      assertOrderPermission: async () => { permissions += 1; }
    }));

    const wallet = await client.getSpotUsdtWallet();
    expect(wallet.available.toString()).toBe("90");
    expect(wallet.blocked.toString()).toBe("5");
    const portfolio = await client.getSpotPortfolioSummary();
    expect(portfolio.totalEstimatedUsdt.toString()).toBe("120.5");
    expect(portfolio.accountEquityUsd?.toString()).toBe("120.25");

    await client.placeMarketOrder({
      side: "SELL", base: "BTC", quote: "USDT",
      amountBase: new Decimal("0.01"), expectedPrice: new Decimal("50000"), clientOrderId: "uta-unit-1"
    });
    expect(bodyOf(calls.find(call => call.url.pathname.endsWith("/api/v3/trade/place-order"))!)).toEqual({
      category: "SPOT",
      symbol: "BTCUSDT",
      side: "sell",
      orderType: "limit",
      timeInForce: "ioc",
      price: "50000",
      qty: "0.01",
      clientOid: "uta-unit-1"
    });

    const order = await client.getOrderStatusByClientOrderId("uta-unit-1");
    expect(order.status).toBe("Done");
    expect(order.fee.toString()).toBe("0.25");
    expect(order.feeBreakdown?.map(item => [item.asset, item.amount.toString()])).toEqual([
      ["USDT", "0.25"],
      ["BGB", "0.01"]
    ]);
    await client.cancelOrder("uta-9001");
    expect(bodyOf(calls.find(call => call.url.pathname.endsWith("/api/v3/trade/cancel-order"))!)).toEqual({
      category: "SPOT",
      orderId: "uta-9001"
    });
    expect(permissions).toBe(2);
    expect(calls.filter(call => call.url.pathname.endsWith("/api/v3/account/assets"))).toHaveLength(1);
  });
});

describe("Bitget private transport fail-closed guards", () => {
  test("never forwards credentials to a non-official REST origin", async () => {
    const { fetcher, calls } = makeFetch(() => envelope([]));
    const client = new BitgetClient(clientOptions(fetcher, {
      baseUrl: "https://evil.example/collect"
    }));
    await expect(client.getWallets()).rejects.toThrow("exact official origin");
    expect(calls).toHaveLength(0);
  });

  test("requires key, secret, and passphrase before a private request", async () => {
    const { fetcher, calls } = makeFetch(() => envelope([]));
    const client = new BitgetClient(clientOptions(fetcher, {
      credentials: { apiKey: "key", apiSecret: "secret", passphrase: "" }
    }));
    await expect(client.getWallets()).rejects.toThrow("key, secret and passphrase");
    expect(calls).toHaveLength(0);
  });
});
