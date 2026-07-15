import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { defaultBotSettings, type BotSettings } from "@/lib/bot-settings";
import { findTriangularOpportunities } from "@/lib/bot/engine";
import {
  applyConfirmedOrderToInventory,
  executeLive,
  LiveManualInterventionError,
  recoverIntermediateInventory,
  type LiveExecutionClient
} from "@/lib/bot/executor";
import type { BitgetOrder, MarketOptions, OrderBook, Side } from "@/lib/exchanges/types";

const now = Date.now();
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

const order = (input: Partial<BitgetOrder> & Pick<BitgetOrder, "id" | "status">): BitgetOrder => ({
  id: input.id,
  status: input.status,
  amount: input.amount ?? new Decimal(0),
  matchedAmount: input.matchedAmount ?? new Decimal(0),
  unmatchedAmount: input.unmatchedAmount ?? new Decimal(0),
  totalPrice: input.totalPrice ?? new Decimal(0),
  averagePrice: input.averagePrice ?? new Decimal(0),
  fee: input.fee ?? new Decimal(0),
  feeAsset: input.feeAsset,
  feeBreakdown: input.feeBreakdown,
  raw: input.raw ?? {}
});

const settings: BotSettings = {
  ...defaultBotSettings,
  tomanTakerFeeBps: 0,
  usdtTakerFeeBps: 0,
  slippageBufferBps: 0,
  liveSafetyBufferBps: 0,
  maxPriceImpactBps: 100,
  maxSpreadBps: 100,
  orderbookDepthUsagePercent: 100,
  minProfitBps: 0,
  minNetProfitToman: 0,
  orderbookMaxAgeMs: 60_000,
  orderTimeoutMs: 1_000
};

const options: MarketOptions = {
  amountSteps: {
    BTCUSDT: new Decimal("0.000001"),
    ETHBTC: new Decimal("0.0001"),
    ETHUSDT: new Decimal("0.0001"),
    USDTETH: new Decimal("0.01")
  },
  priceSteps: {
    BTCUSDT: new Decimal("0.1"),
    ETHBTC: new Decimal("0.000001"),
    ETHUSDT: new Decimal("0.1"),
    USDTETH: new Decimal("0.0000001")
  },
  minTradeUsdtBySymbol: {
    BTCUSDT: new Decimal(5),
    ETHBTC: new Decimal(5),
    ETHUSDT: new Decimal(5),
    USDTETH: new Decimal(5)
  },
  minOrderRial: new Decimal(0),
  minOrderUsdt: new Decimal(5)
};

type Submission = {
  side: Side;
  base: string;
  quote: string;
  amountBase: Decimal;
  expectedPrice: Decimal;
  clientOrderId: string;
};

class MockClient implements LiveExecutionClient {
  readonly placed: Submission[] = [];

  constructor(
    private readonly books: OrderBook[],
    private readonly orders: BitgetOrder[],
    private readonly marketOptions: MarketOptions = options
  ) {}

  async getAllOrderBooks() { return this.books; }
  async getMarketOptions() { return this.marketOptions; }
  async placeMarketOrder(input: Submission) {
    this.placed.push(input);
    const next = this.orders.shift();
    if (!next) throw new Error("Mock has no Bitget order response");
    return next;
  }
  async getOrderStatus(id: string) {
    const next = this.orders.shift();
    if (!next) throw new Error(`Mock has no status for ${id}`);
    return next;
  }
  async cancelOrder() { return undefined; }
}

describe("fee-asset-aware fill ledger", () => {
  test("subtracts a fee only from the asset Bitget actually charged", () => {
    const market = { base: "BTC", quote: "USDT" };
    const baseOrder = order({
      id: "buy",
      status: "filled",
      matchedAmount: new Decimal(1),
      totalPrice: new Decimal(50_000),
      fee: new Decimal("0.001")
    });
    const chargedInBase = applyConfirmedOrderToInventory(
      { USDT: new Decimal(50_000) }, market, "BUY", { ...baseOrder, feeAsset: "BTC" }
    );
    expect(chargedInBase.BTC?.toString()).toBe("0.999");
    expect(chargedInBase.USDT?.toString()).toBe("0");

    const chargedInBgb = applyConfirmedOrderToInventory(
      { USDT: new Decimal(50_000) }, market, "BUY", { ...baseOrder, feeAsset: "BGB" }
    );
    expect(chargedInBgb.BTC?.toString()).toBe("1");
    expect(chargedInBgb.BGB).toBeUndefined();

    const mixed = applyConfirmedOrderToInventory(
      { USDT: new Decimal(50_000) },
      market,
      "BUY",
      {
        ...baseOrder,
        fee: new Decimal(0),
        feeAsset: undefined,
        feeBreakdown: [
          { asset: "BTC", amount: new Decimal("0.001") },
          { asset: "BGB", amount: new Decimal("0.1") }
        ]
      }
    );
    expect(mixed.BTC?.toString()).toBe("0.999");
    expect(mixed.BGB).toBeUndefined();
  });
});

describe("generic Bitget USDT recovery", () => {
  test("sells a direct ASSET/USDT market", async () => {
    const client = new MockClient(
      [book("ETHUSDT", "ETH", "USDT", 2_500, 2_501, 10)],
      [order({
        id: "direct",
        status: "filled",
        amount: new Decimal("0.4"),
        matchedAmount: new Decimal("0.4"),
        totalPrice: new Decimal(1_000),
        averagePrice: new Decimal(2_500),
        fee: new Decimal(1),
        feeAsset: "USDT"
      })]
    );
    const result = await recoverIntermediateInventory({
      reason: "test",
      actualInputToman: 1_000,
      inventory: [{ asset: "ETH", amount: new Decimal("0.4") }],
      settings,
      options,
      client,
      now: () => now
    });
    expect(client.placed.map(item => `${item.side}:${item.base}/${item.quote}`)).toEqual(["SELL:ETH/USDT"]);
    expect(result.recoveredToman.toString()).toBe("999");
    expect(result.residualInventory).toHaveLength(0);
  });

  test("uses BUY on an inverse USDT/ASSET market", async () => {
    const client = new MockClient(
      [book("USDTETH", "USDT", "ETH", "0.000399", "0.0004", 10_000)],
      [order({
        id: "inverse",
        status: "filled",
        amount: new Decimal(1_000),
        matchedAmount: new Decimal(1_000),
        totalPrice: new Decimal("0.4"),
        averagePrice: new Decimal("0.0004"),
        fee: new Decimal(1),
        feeAsset: "USDT"
      })]
    );
    const sides: Side[] = [];
    const result = await recoverIntermediateInventory({
      reason: "inverse test",
      actualInputToman: 1_000,
      inventory: [{ asset: "ETH", amount: new Decimal("0.4") }],
      settings,
      options,
      client,
      now: () => now,
      hooks: { onBeforeRecoveryOrder: event => { sides.push(event.side); } }
    });
    expect(client.placed.map(item => `${item.side}:${item.base}/${item.quote}`)).toEqual(["BUY:USDT/ETH"]);
    expect(client.placed[0]?.amountBase.toString()).toBe("1000");
    expect(sides).toEqual(["BUY"]);
    expect(result.recoveredToman.toString()).toBe("999");
    expect(result.residualInventory).toHaveLength(0);
  });

  test("re-quotes and retries a confirmed partial direct fill", async () => {
    const client = new MockClient(
      [book("ETHUSDT", "ETH", "USDT", 2_500, 2_501, 10)],
      [
        order({
          id: "partial",
          status: "cancelled",
          amount: new Decimal("0.4"),
          matchedAmount: new Decimal("0.2"),
          unmatchedAmount: new Decimal("0.2"),
          totalPrice: new Decimal(500),
          averagePrice: new Decimal(2_500),
          feeAsset: "USDT"
        }),
        order({
          id: "remainder",
          status: "filled",
          amount: new Decimal("0.2"),
          matchedAmount: new Decimal("0.2"),
          totalPrice: new Decimal(500),
          averagePrice: new Decimal(2_500),
          feeAsset: "USDT"
        })
      ]
    );
    const result = await recoverIntermediateInventory({
      reason: "partial",
      actualInputToman: 1_000,
      inventory: [{ asset: "ETH", amount: new Decimal("0.4") }],
      settings,
      options,
      client,
      now: () => now,
      maxAttemptsPerAsset: 2
    });
    expect(result.legs.map(leg => leg.orderId)).toEqual(["partial", "remainder"]);
    expect(result.recoveredToman.toString()).toBe("1000");
    expect(result.residualInventory).toHaveLength(0);
  });

  test("treats an inverse route below symbol minTradeUSDT as residual dust", async () => {
    const strictOptions: MarketOptions = {
      ...options,
      minTradeUsdtBySymbol: { ...options.minTradeUsdtBySymbol!, USDTETH: new Decimal(1_100) }
    };
    const client = new MockClient(
      [book("USDTETH", "USDT", "ETH", "0.000399", "0.0004", 10_000)],
      [],
      strictOptions
    );
    const result = await recoverIntermediateInventory({
      reason: "minimum",
      actualInputToman: 1_000,
      inventory: [{ asset: "ETH", amount: new Decimal("0.4") }],
      settings,
      options: strictOptions,
      client,
      now: () => now
    });
    expect(client.placed).toHaveLength(0);
    expect(result.residualInventory[0]?.amount.toString()).toBe("0.4");
    expect(result.residualValueToman.toString()).toBe("1000");
  });

  test("fails closed when every recovery market violates spread limits", async () => {
    const client = new MockClient(
      [book("ETHUSDT", "ETH", "USDT", 2_000, 2_500, 10)],
      []
    );
    await expect(recoverIntermediateInventory({
      reason: "unsafe",
      actualInputToman: 1_000,
      inventory: [{ asset: "ETH", amount: new Decimal("0.4") }],
      settings,
      options,
      client,
      now: () => now
    })).rejects.toBeInstanceOf(LiveManualInterventionError);
  });
});

describe("full triangular execution", () => {
  test("accepts Bitget filled statuses and accounts for mixed-asset fees", async () => {
    const books = [
      book("BTCUSDT", "BTC", "USDT", 49_990, 50_000, 10),
      book("ETHBTC", "ETH", "BTC", "0.0499", "0.05", 1_000),
      book("ETHUSDT", "ETH", "USDT", 2_550, 2_551, 1_000),
      book("BGBUSDT", "BGB", "USDT", 200, 201, 1_000)
    ];
    const opportunity = findTriangularOpportunities({
      books,
      options,
      capitalToman: 1_000,
      now,
      tomanFeeBps: 0,
      usdtFeeBps: 0,
      slippageBps: 0,
      maxPriceImpactBps: 100,
      maxSpreadBps: 100,
      depthUsagePercent: 100,
      minProfitBps: 0,
      minNetProfitToman: 0,
      maxAgeMs: 60_000
    }).find(item => item.route.join(",") === "USDT,BTC,ETH,USDT")!;
    const client = new MockClient(books, [
      order({
        id: "leg-1", status: "filled", amount: new Decimal("0.02"), matchedAmount: new Decimal("0.02"),
        totalPrice: new Decimal(1_000), averagePrice: new Decimal(50_000), feeAsset: "BTC"
      }),
      order({
        id: "leg-2", status: "filled", amount: new Decimal("0.4"), matchedAmount: new Decimal("0.4"),
        totalPrice: new Decimal("0.02"), averagePrice: new Decimal("0.05"), feeAsset: "ETH"
      }),
      order({
        id: "leg-3", status: "filled", amount: new Decimal("0.4"), matchedAmount: new Decimal("0.4"),
        totalPrice: new Decimal(1_020), averagePrice: new Decimal(2_550),
        feeBreakdown: [
          { asset: "USDT", amount: new Decimal(1) },
          { asset: "BGB", amount: new Decimal("0.1") }
        ]
      })
    ]);

    const result = await executeLive(opportunity, settings, client, {}, { books, options });
    expect(client.placed.map(item => `${item.side}:${item.base}/${item.quote}`))
      .toEqual(["BUY:BTC/USDT", "BUY:ETH/BTC", "SELL:ETH/USDT"]);
    expect(result.externalFeeValueToman.toFixed(8)).toBe("20.10000000");
    expect(result.realizedOutputToman.toFixed(8)).toBe("998.90000000");
    expect(result.realizedProfitToman.toFixed(8)).toBe("-1.10000000");
  });

  test("raises a typed manual-stop error when a third-asset fee cannot be valued", async () => {
    const books = [
      book("BTCUSDT", "BTC", "USDT", 49_990, 50_000, 10),
      book("ETHBTC", "ETH", "BTC", "0.0499", "0.05", 1_000),
      book("ETHUSDT", "ETH", "USDT", 2_550, 2_551, 1_000)
    ];
    const opportunity = findTriangularOpportunities({
      books, options, capitalToman: 1_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 100, maxSpreadBps: 100, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 60_000
    }).find(item => item.route.join(",") === "USDT,BTC,ETH,USDT")!;
    const client = new MockClient(books, [
      order({
        id: "leg-1", status: "filled", amount: new Decimal("0.02"), matchedAmount: new Decimal("0.02"),
        totalPrice: new Decimal(1_000), averagePrice: new Decimal(50_000), feeAsset: "BTC"
      }),
      order({
        id: "leg-2", status: "filled", amount: new Decimal("0.4"), matchedAmount: new Decimal("0.4"),
        totalPrice: new Decimal("0.02"), averagePrice: new Decimal("0.05"), feeAsset: "ETH"
      }),
      order({
        id: "leg-3", status: "filled", amount: new Decimal("0.4"), matchedAmount: new Decimal("0.4"),
        totalPrice: new Decimal(1_020), averagePrice: new Decimal(2_550),
        fee: new Decimal("0.1"), feeAsset: "BGB"
      })
    ]);
    let manualHook = false;
    await expect(executeLive(opportunity, settings, client, {
      onManualInterventionRequired: () => { manualHook = true; }
    }, { books, options })).rejects.toBeInstanceOf(LiveManualInterventionError);
    expect(manualHook).toBe(true);
  });
});
