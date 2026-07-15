import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  findTriangularOpportunities,
  findTriangularOpportunitiesDetailed,
  quoteEdge,
  type ArbitrageSearchInput
} from "@/lib/bot/engine";
import {
  liveSafetyRejectionReason,
  realizedOrderOutput,
  repriceLiveOpportunity
} from "@/lib/bot/executor";
import { botSettingsSchema, defaultBotSettings } from "@/lib/bot-settings";
import type { BitgetOrder, MarketOptions, OrderBook } from "@/lib/exchanges/types";

const now = 1_800_000_000_000;
const book = (
  symbol: string,
  base: string,
  quote: string,
  bid: Decimal.Value,
  ask: Decimal.Value,
  amount: Decimal.Value = 1_000
): OrderBook => ({
  symbol,
  base,
  quote,
  lastUpdate: now,
  bids: [{ price: new Decimal(bid), amount: new Decimal(amount) }],
  asks: [{ price: new Decimal(ask), amount: new Decimal(amount) }]
});

const triangleBooks = () => [
  book("BTCUSDT", "BTC", "USDT", "49990", "50000", 10),
  book("ETHBTC", "ETH", "BTC", "0.0499", "0.05", 1_000),
  book("ETHUSDT", "ETH", "USDT", "2550", "2551", 1_000)
];

const options: MarketOptions = {
  amountSteps: {
    BTCUSDT: new Decimal("0.000001"),
    ETHBTC: new Decimal("0.0001"),
    ETHUSDT: new Decimal("0.0001")
  },
  priceSteps: {
    BTCUSDT: new Decimal("0.1"),
    ETHBTC: new Decimal("0.000001"),
    ETHUSDT: new Decimal("0.1")
  },
  minTradeUsdtBySymbol: {
    BTCUSDT: new Decimal(5),
    ETHBTC: new Decimal(5),
    ETHUSDT: new Decimal(5)
  },
  minOrderRial: new Decimal(0),
  minOrderUsdt: new Decimal(5)
};

const search = (books = triangleBooks(), extra: Partial<ArbitrageSearchInput> = {}) =>
  findTriangularOpportunities({
    books,
    capitalToman: 1_000,
    now,
    tomanFeeBps: 0,
    usdtFeeBps: 0,
    slippageBps: 0,
    maxPriceImpactBps: 100,
    maxSpreadBps: 100,
    depthUsagePercent: 100,
    minProfitBps: 1,
    minNetProfitToman: 0,
    maxAgeMs: 1_000,
    ...extra
  });

describe("Bitget triangular engine", () => {
  test("builds a real USDT -> BTC -> ETH -> USDT triangle", () => {
    const route = search().find(item => item.route.join(",") === "USDT,BTC,ETH,USDT");
    expect(route).toBeDefined();
    expect(route!.outputToman.toFixed(8)).toBe("1020.00000000");
    expect(route!.netProfitToman.toFixed(8)).toBe("20.00000000");
    expect(route!.executable).toBe(true);
    expect(new Set(route!.legs.map(leg => leg.edge.book.symbol)).size).toBe(3);
  });

  test("walks multiple levels and rejects input beyond reserved depth", () => {
    const market = book("BTCUSDT", "BTC", "USDT", 49_990, 50_000, "0.01");
    market.asks.push({ price: new Decimal(51_000), amount: new Decimal("0.01") });
    const edge = { id: "BTCUSDT:BUY", from: "USDT", to: "BTC", side: "BUY" as const, book: market };
    const quote = quoteEdge(edge, 1_010, 0, 0);
    expect(quote?.levelsUsed).toBe(2);
    expect(quote?.output.toString()).toBe("0.02");
    expect(quoteEdge(edge, "1010.0001", 0, 0)).toBeUndefined();
  });

  test("reserves visible liquidity and reports depth consumption", () => {
    const market = book("BTCUSDT", "BTC", "USDT", 99, 100, 10);
    const edge = { id: "BTCUSDT:BUY", from: "USDT", to: "BTC", side: "BUY" as const, book: market };
    expect(quoteEdge(edge, 901, 0, 0, 90)).toBeUndefined();
    const quote = quoteEdge(edge, 900, 0, 0, 90);
    expect(quote?.output.toString()).toBe("9");
    expect(quote?.availableInput.toString()).toBe("900");
    expect(quote?.depthConsumedPercent.toString()).toBe("100");
  });

  test("invalidates cached depth when a same-length book is mutated", () => {
    const market = book("BTCUSDT", "BTC", "USDT", 99, 100, 10);
    const edge = { id: "BTCUSDT:BUY", from: "USDT", to: "BTC", side: "BUY" as const, book: market };
    expect(quoteEdge(edge, 100, 0, 0)?.output.toString()).toBe("1");
    market.asks[0] = { price: new Decimal(200), amount: new Decimal(10) };
    expect(quoteEdge(edge, 100, 0, 0)?.output.toString()).toBe("0.5");
  });

  test("sizes down to a safe depth breakpoint", () => {
    const books = triangleBooks();
    books[0]!.asks = [
      { price: new Decimal(50_000), amount: new Decimal("0.01") },
      { price: new Decimal(55_000), amount: new Decimal(10) }
    ];
    const route = search(books, { maxPriceImpactBps: 50 })
      .find(item => item.route.join(",") === "USDT,BTC,ETH,USDT");
    expect(route?.inputToman.toString()).toBe("500");
    expect(route?.requestedInputToman.toString()).toBe("1000");
    expect(route?.sizedByDepth).toBe(true);
    expect(route?.liquiditySafe).toBe(true);
  });

  test("uses a single diagnostic size for a path that cannot be profitable", () => {
    const books = triangleBooks();
    books[1] = book("ETHBTC", "ETH", "BTC", "0.049", "0.051", 1_000);
    books[2] = book("ETHUSDT", "ETH", "USDT", 2_450, 2_550, 1_000);
    const result = findTriangularOpportunitiesDetailed({
      books,
      capitalToman: 1_000,
      now,
      tomanFeeBps: 0,
      usdtFeeBps: 0,
      slippageBps: 0,
      maxPriceImpactBps: 10_000,
      maxSpreadBps: 1_000,
      depthUsagePercent: 100,
      minProfitBps: 0,
      minNetProfitToman: 0,
      maxAgeMs: 1_000
    });
    expect(result.stats.promisingPathCount).toBe(0);
    expect(result.opportunities.every(item => item.sizingMode === "diagnostic-minimum")).toBe(true);
  });

  test("prefers official per-symbol fees and falls back by quote market", () => {
    const official = search(triangleBooks(), {
      options: {
        ...options,
        takerFeeBpsBySymbol: {
          BTCUSDT: new Decimal(10),
          ETHBTC: new Decimal(20),
          ETHUSDT: new Decimal(30)
        }
      },
      tomanFeeBps: 100,
      usdtFeeBps: 200,
      minProfitBps: 0
    }).find(item => item.route.join(",") === "USDT,BTC,ETH,USDT")!;
    expect(official.legs.map(leg => leg.fee.div(leg.grossOutput).mul(10_000).toFixed(0)))
      .toEqual(["10", "20", "30"]);

    const fallback = search(triangleBooks(), {
      tomanFeeBps: 100,
      usdtFeeBps: 200,
      minProfitBps: 0
    }).find(item => item.route.join(",") === "USDT,BTC,ETH,USDT")!;
    expect(fallback.legs.map(leg => leg.fee.div(leg.grossOutput).mul(10_000).toFixed(0)))
      .toEqual(["100", "200", "100"]);
  });

  test("enforces Bitget minTradeUSDT on a cross-quote leg", () => {
    const constrained: MarketOptions = {
      ...options,
      minTradeUsdtBySymbol: { ...options.minTradeUsdtBySymbol!, ETHBTC: new Decimal(1_100) }
    };
    const route = search(triangleBooks(), { options: constrained, minProfitBps: 0 })
      .find(item => item.route.join(",") === "USDT,BTC,ETH,USDT");
    expect(route).toBeDefined();
    expect(route?.liquiditySafe).toBe(false);
    expect(route?.executable).toBe(false);
    expect(route?.rejectionReason).toContain("ETHBTC");
  });

  test("supports an exact quote-currency minimum for a cross market", () => {
    const constrained: MarketOptions = {
      ...options,
      minOrderQuoteBySymbol: { ETHBTC: new Decimal("0.03") }
    };
    const route = search(triangleBooks(), { options: constrained, minProfitBps: 0 })
      .find(item => item.route.join(",") === "USDT,BTC,ETH,USDT");
    expect(route?.liquiditySafe).toBe(false);
  });

  test("fails closed on crossed, future-dated, skewed, or precision-less snapshots", () => {
    const crossed = triangleBooks();
    crossed[0]!.bids[0]!.price = new Decimal(50_001);
    expect(search(crossed, { options })).toHaveLength(0);

    const future = triangleBooks();
    future[1]!.lastUpdate = now + 1_001;
    expect(search(future, { options })).toHaveLength(0);

    const skewed = triangleBooks();
    skewed[2]!.lastUpdate = now - 1_001;
    expect(search(skewed, { options, maxAgeMs: 5_000 })).toHaveLength(0);

    expect(search(triangleBooks(), { options: { ...options, priceSteps: {} } })).toHaveLength(0);
  });

  test("reprices the same route against a fresh Bitget snapshot", () => {
    const selected = search().find(item => item.route.join(",") === "USDT,BTC,ETH,USDT")!;
    const fresh = triangleBooks();
    fresh[0]!.asks = [
      { price: new Decimal(50_000), amount: new Decimal("0.01") },
      { price: new Decimal(55_000), amount: new Decimal(10) }
    ];
    const settings = botSettingsSchema.parse({
      ...defaultBotSettings,
      tomanTakerFeeBps: 0,
      usdtTakerFeeBps: 0,
      slippageBufferBps: 0,
      liveSafetyBufferBps: 0,
      maxPriceImpactBps: 50,
      maxSpreadBps: 100,
      orderbookDepthUsagePercent: 100,
      minProfitBps: 0,
      minNetProfitToman: 0
    });
    const repriced = repriceLiveOpportunity(selected, settings, fresh, options, now);
    expect(repriced?.inputToman.toString()).toBe("500");
    expect(repriced?.sizedByDepth).toBe(true);
  });

  test("subtracts fee and slippage from a simulated conversion", () => {
    const market = book("BTCUSDT", "BTC", "USDT", 100, 101);
    const edge = { id: "BTCUSDT:SELL", from: "BTC", to: "USDT", side: "SELL" as const, book: market };
    expect(quoteEdge(edge, 1, 100, 100)?.output.toFixed(4)).toBe("98.0100");
  });

  test("uses feeAsset when calculating realized Bitget fills", () => {
    const market = { base: "BTC", quote: "USDT" };
    const order = (input: Partial<BitgetOrder>): BitgetOrder => ({
      id: "1",
      status: "filled",
      amount: new Decimal(1),
      matchedAmount: new Decimal(1),
      unmatchedAmount: new Decimal(0),
      totalPrice: new Decimal(50_000),
      averagePrice: new Decimal(50_000),
      fee: new Decimal("0.001"),
      raw: {},
      ...input
    });
    expect(realizedOrderOutput("BUY", market, order({ feeAsset: "BTC" })).toString()).toBe("0.999");
    expect(realizedOrderOutput("BUY", market, order({ feeAsset: "BGB" })).toString()).toBe("1");
    expect(realizedOrderOutput("BUY", market, order({
      fee: new Decimal(0),
      feeAsset: undefined,
      feeBreakdown: [
        { asset: "BTC", amount: new Decimal("0.001") },
        { asset: "BGB", amount: new Decimal("0.1") }
      ]
    })).toString()).toBe("0.999");
    expect(realizedOrderOutput("SELL", market, order({ fee: new Decimal(10), feeAsset: "USDT" })).toString()).toBe("49990");
    expect(realizedOrderOutput("SELL", market, order({ fee: new Decimal(10), feeAsset: "BGB" })).toString()).toBe("50000");
  });

  test("requires the configured Live safety return", () => {
    const candidate = search()[0]!;
    const settings = { ...defaultBotSettings, minProfitBps: 80, liveSafetyBufferBps: 150, minNetProfitToman: 1 };
    expect(liveSafetyRejectionReason({ ...candidate, netProfitToman: new Decimal(2) }, settings)).toContain("Live");
    expect(liveSafetyRejectionReason({ ...candidate, netProfitToman: new Decimal(30) }, settings)).toBeUndefined();
  });
});

describe("dashboard settings compatibility", () => {
  test("loads settings saved before liquidity controls existed", () => {
    const legacy = { ...defaultBotSettings } as Partial<typeof defaultBotSettings>;
    delete legacy.maxPriceImpactBps;
    delete legacy.maxSpreadBps;
    delete legacy.orderbookDepthUsagePercent;
    delete legacy.liveSafetyBufferBps;
    delete legacy.bitgetAccountMode;
    delete legacy.bitgetDemoTrading;
    const migrated = botSettingsSchema.parse(legacy);
    expect(migrated.maxPriceImpactBps).toBe(25);
    expect(migrated.maxSpreadBps).toBe(80);
    expect(migrated.orderbookDepthUsagePercent).toBe(40);
    expect(migrated.liveSafetyBufferBps).toBe(150);
    expect(migrated.bitgetAccountMode).toBe("uta");
    expect(migrated.bitgetDemoTrading).toBe(false);
  });
});
