import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import type { MarketOptions, BitgetOrder, OrderBook } from "@/lib/exchanges/types";
import type { StrategySignal } from "@/lib/strategies/types";
import {
  createSpotPositionExecutionPlan,
  executeSpotPosition,
  revalidateSpotPositionEntry,
  SpotPositionExecutionError,
  type SpotPositionExecutionClient,
  type SpotPositionOrderRequest,
  type SpotPositionPlanConfig
} from "@/lib/strategies/spot-position-executor";

const startedAt = 1_800_000_000_000;

function book(symbol: string, base: string, bid: number, ask: number, bidAmount = 10_000, askAmount = 10_000, at = startedAt): OrderBook {
  return {
    symbol,
    base,
    quote: "USDT",
    lastUpdate: at,
    bids: [{ price: new Decimal(bid), amount: new Decimal(bidAmount) }],
    asks: [{ price: new Decimal(ask), amount: new Decimal(askAmount) }]
  };
}

function imbalanceSignal(): StrategySignal {
  return {
    id: "imbalance:XUSDT",
    kind: "orderbook-imbalance",
    title: "X imbalance",
    symbols: ["XUSDT"],
    action: "BUY",
    status: "actionable",
    paperOnly: true,
    expectedEdgeBps: new Decimal(0),
    estimatedNetProfitToman: new Decimal(0),
    confidence: new Decimal(70),
    reasons: [],
    metrics: {
      direction: "LONG",
      spotExecutable: true,
      ratio: 3,
      capitalToman: 100_000,
      temporalConfirmed: true,
      spoofingGuardPassed: true,
      priceConfirmationPassed: true,
      executionDepthSafe: true
    },
    scannedAt: startedAt
  };
}

function gapSignal(): StrategySignal {
  return {
    id: "gap:XUSDT:ask:2",
    kind: "orderbook-gap",
    title: "X ask liquidity gap",
    symbols: ["XUSDT"],
    action: "BUY",
    status: "actionable",
    paperOnly: true,
    expectedEdgeBps: new Decimal(200),
    estimatedNetProfitToman: new Decimal(2_000),
    confidence: new Decimal(75),
    reasons: [],
    metrics: {
      direction: "LONG",
      spotExecutable: true,
      analyticalSetupPassed: true,
      liveSetupPassed: true,
      outcomeCalibrated: true,
      temporalConfirmed: true,
      gapBps: 1_600,
      capitalToman: 100_000
    },
    scannedAt: startedAt
  };
}

function gapBook(): OrderBook {
  return {
    symbol: "XUSDT",
    base: "X",
    quote: "USDT",
    lastUpdate: startedAt,
    bids: [
      { price: new Decimal(99), amount: new Decimal(10_000) },
      { price: new Decimal(98), amount: new Decimal(10_000) },
      { price: new Decimal(97), amount: new Decimal(10_000) },
      { price: new Decimal(96), amount: new Decimal(10_000) }
    ],
    asks: [
      { price: new Decimal(101), amount: new Decimal(10_000) },
      { price: new Decimal(102), amount: new Decimal(10_000) },
      { price: new Decimal(120), amount: new Decimal(10_000) },
      { price: new Decimal(121), amount: new Decimal(10_000) }
    ]
  };
}

const common: Omit<SpotPositionPlanConfig, "imbalance"> = {
  capitalToman: 100_000,
  tomanTakerFeeBps: 0,
  slippageBps: 0,
  liveSafetyBufferBps: 0,
  maxSpreadBps: 500,
  maxPriceImpactBps: 50,
  depthUsagePercent: 100,
  maxAgeMs: 5_000,
  orderTimeoutMs: 1_000,
  orderReserveBps: 0,
  takeProfitBps: 50,
  stopLossBps: 250,
  maxLossToman: 5_000,
  maxResidualToman: 1_000,
  maxHoldMs: 5_000,
  pollIntervalMs: 1_000,
  recoveryMaxSpreadBps: 2_000,
  recoveryMaxPriceImpactBps: 2_000,
  recoverySlippageBps: 100
};

function imbalancePlan(overrides: Partial<NonNullable<SpotPositionPlanConfig["imbalance"]>> = {}) {
  return createSpotPositionExecutionPlan(imbalanceSignal(), {
    ...common,
    imbalance: { levels: 1, levelWeightDecayPercent: 70, minRatio: 2, exitRatio: 1.25, minVisibleDepthToman: 50_000, maxTopLevelSharePercent: 100, minMicropriceBiasBps: 0, ...overrides }
  }, startedAt);
}

function gapPlan() {
  return createSpotPositionExecutionPlan(gapSignal(), {
    ...common,
    gap: { levels: 4, baselineLevels: 4, gapIndex: 1, minGapBps: 500, minGapZScore: 3, minGapRatio: 4 }
  }, startedAt);
}

const marketOptions: MarketOptions = {
  amountSteps: { XUSDT: new Decimal("0.00000001") },
  priceSteps: { XUSDT: new Decimal("0.1") },
  minOrderRial: new Decimal(500_000),
  minOrderUsdt: new Decimal(11)
};

class MockClient implements SpotPositionExecutionClient {
  baseUrl = "https://api.bitget.com";
  readonly placed: SpotPositionOrderRequest[] = [];
  getOrderStatusByClientOrderId?: (clientOrderId: string) => Promise<BitgetOrder>;
  private snapshotIndex = 0;
  private orderIndex = 0;

  constructor(
    private readonly snapshots: OrderBook[][],
    private readonly orderFactory: (request: SpotPositionOrderRequest, index: number) => BitgetOrder = filledOrder,
    private readonly options: MarketOptions = marketOptions
  ) {}

  async getAllOrderBooks() {
    return this.snapshots[Math.min(this.snapshotIndex++, this.snapshots.length - 1)]!;
  }
  async getMarketOptions() { return this.options; }
  async placeMarketOrder(request: SpotPositionOrderRequest) {
    this.placed.push(request);
    return this.orderFactory(request, this.orderIndex++);
  }
  async getOrderStatus(_id: string): Promise<BitgetOrder> { throw new Error("unused"); }
  async cancelOrder(_id: string): Promise<void> { throw new Error("unused"); }
}

function filledOrder(request: SpotPositionOrderRequest, index: number): BitgetOrder {
  const priceToman = request.side === "BUY" ? 100 : 102;
  return {
    id: `order-${index + 1}`,
    status: "Done",
    amount: request.amountBase,
    matchedAmount: request.amountBase,
    unmatchedAmount: new Decimal(0),
    totalPrice: request.amountBase.mul(priceToman).mul(10),
    averagePrice: new Decimal(priceToman).mul(10),
    fee: new Decimal(0),
    raw: { index }
  };
}

function clock() {
  let value = startedAt;
  return {
    now: () => value,
    sleep: async (ms: number) => { value += ms; },
    touch: (books: OrderBook[]) => books.map(value => ({ ...value, lastUpdate: value.lastUpdate === startedAt ? startedAt : value.lastUpdate }))
  };
}

describe("Mainnet Spot position executor", () => {
  test("builds and freshly revalidates a calibrated Gap Trading plan", () => {
    const plan = gapPlan();
    const validation = revalidateSpotPositionEntry(plan, [gapBook()], startedAt);
    expect(plan).toMatchObject({ strategy: "orderbook-gap", riskStrategy: "gapTrading", symbol: "XUSDT" });
    expect(plan.config.gapIndex).toBe(1);
    expect(validation.metric.gte(500)).toBe(true);
    expect(validation.entryQuote.output.gt(0)).toBe(true);
  });

  test("creates a frozen long-only plan and rejects an unconfirmed signal", () => {
    const plan = imbalancePlan();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.config)).toBe(true);
    expect(plan).toMatchObject({ strategy: "orderbook-imbalance", riskStrategy: "imbalance", symbol: "XUSDT", direction: "LONG" });
    const unconfirmed = { ...imbalanceSignal(), metrics: { ...imbalanceSignal().metrics, temporalConfirmed: false } };
    expect(() => createSpotPositionExecutionPlan(unconfirmed, { ...common, imbalance: { levels: 1, levelWeightDecayPercent: 70, minRatio: 2, exitRatio: 1.25, minVisibleDepthToman: 50_000, maxTopLevelSharePercent: 100, minMicropriceBiasBps: 0 } })).toThrow();
  });

  test("rejects every hostname except the exact official Bitget Mainnet host before reading a book", async () => {
    let reads = 0;
    const client = new MockClient([[book("XUSDT", "X", 99, 100, 3_000, 1_000)]]) as MockClient & { baseUrl: string };
    client.baseUrl = "https://example.invalid";
    client.getAllOrderBooks = async () => { reads += 1; return []; };
    await expect(executeSpotPosition(imbalancePlan(), client)).rejects.toMatchObject({ code: "MAINNET_REQUIRED" });
    expect(reads).toBe(0);
  });

  test("closes an imbalance position when the book normalizes", async () => {
    const c = clock();
    const heavy = [book("XUSDT", "X", 99, 100, 3_000, 1_000)];
    const normal = [book("XUSDT", "X", 102, 103, 1_000, 1_000, startedAt + 1_000)];
    const client = new MockClient([heavy, heavy, normal]);
    const result = await executeSpotPosition(imbalancePlan(), client, {}, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 });
    expect(result.status).toBe("completed");
    expect(["imbalance-normalized", "take-profit"]).toContain(result.exitReason);
    expect(result.legs.map(value => value.stage)).toEqual(["entry", "exit"]);
  });

  test("live revalidation rejects an imbalance dominated by one spoofable wall before BUY", async () => {
    const wall = book("XUSDT", "X", 99, 101, 5_000, 1_000);
    wall.bids.push(
      { price: new Decimal(98), amount: new Decimal(10) },
      { price: new Decimal(97), amount: new Decimal(10) }
    );
    wall.asks.push(
      { price: new Decimal(102), amount: new Decimal(1_000) },
      { price: new Decimal(103), amount: new Decimal(1_000) }
    );
    const client = new MockClient([[wall]]);
    await expect(executeSpotPosition(imbalancePlan({ levels: 3, maxTopLevelSharePercent: 70 }), client, {}, { revalidationDelayMs: 0 }))
      .rejects.toMatchObject({ code: "REVALIDATION_FAILED" });
    expect(client.placed).toHaveLength(0);
  });

  test("blocks entry when snapshot order flow reverses between the two live validations", async () => {
    const first = [book("XUSDT", "X", 99, 100, 3_000, 1_000)];
    // Static depth remains bid-heavy, but both best prices step down and the
    // former bid queue disappears: the transition is adverse despite ratio=3.
    const reversed = [book("XUSDT", "X", 98, 99, 3_000, 1_000)];
    const client = new MockClient([first, reversed]);
    const plan = imbalancePlan({
      minOrderFlowImbalance: 0.03,
      minLiquidityRetentionPercent: 60
    });

    await expect(executeSpotPosition(plan, client, {}, { revalidationDelayMs: 0 }))
      .rejects.toMatchObject({ code: "REVALIDATION_FAILED" });
    expect(client.placed).toHaveLength(0);
  });

  test("rejects a market entry when round-trip friction would trigger Stop Loss on the first check", async () => {
    const c = clock();
    const plan = createSpotPositionExecutionPlan(imbalanceSignal(), {
      ...common,
      capitalToman: 250_000,
      tomanTakerFeeBps: 25,
      slippageBps: 10,
      stopLossBps: 80,
      maxLossToman: 7_500,
      imbalance: {
        levels: 1,
        levelWeightDecayPercent: 70,
        minRatio: 2,
        exitRatio: 1.25,
        minVisibleDepthToman: 50_000,
        maxTopLevelSharePercent: 100,
        minMicropriceBiasBps: 0
      }
    }, startedAt);
    // This reproduces the economics of the CAKEUSDT loss: roughly 49 BPS spread
    // plus two 25 BPS taker fees already exceeds an 80 BPS Stop Loss.
    const costly = [book("XUSDT", "X", 255_735, 257_000, 3_000, 1_000)];
    const client = new MockClient([costly, costly]);

    await expect(executeSpotPosition(plan, client, {}, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 }))
      .rejects.toMatchObject({ code: "REVALIDATION_FAILED" });
    expect(client.placed).toHaveLength(0);
  });

  test("rejects a BNB-sized entry before ordering when BUY fees would leave valuable unsellable dust", async () => {
    const c = clock();
    const signal = {
      ...imbalanceSignal(),
      id: "imbalance:BNBUSDT",
      symbols: ["BNBUSDT"],
      scannedAt: startedAt
    };
    const plan = createSpotPositionExecutionPlan(signal, {
      ...common,
      capitalToman: 250_000,
      tomanTakerFeeBps: 25,
      maxResidualToman: 1_000,
      imbalance: { levels: 1, levelWeightDecayPercent: 70, minRatio: 2, exitRatio: 1.25, minVisibleDepthToman: 50_000, maxTopLevelSharePercent: 100, minMicropriceBiasBps: 0 }
    }, startedAt);
    const bnbOptions: MarketOptions = {
      amountSteps: { BNBUSDT: new Decimal("0.001") },
      priceSteps: { BNBUSDT: new Decimal(10) },
      minOrderRial: new Decimal(500_000),
      minOrderUsdt: new Decimal(5)
    };
    const heavy = [book("BNBUSDT", "BNB", 104_799_655, 105_101_112, 0.03, 0.01)];
    const client = new MockClient([heavy, heavy], filledOrder, bnbOptions);

    await expect(executeSpotPosition(plan, client, {}, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 }))
      .rejects.toMatchObject({ code: "REVALIDATION_FAILED" });
    expect(client.placed).toHaveLength(0);
  });

  test("never realizes PnL or double-sells when an unexpected BUY fee leaves a valuable residual", async () => {
    const c = clock();
    const signal = {
      ...imbalanceSignal(),
      id: "imbalance:BNBUSDT",
      symbols: ["BNBUSDT"],
      scannedAt: startedAt
    };
    const plan = createSpotPositionExecutionPlan(signal, {
      ...common,
      capitalToman: 250_000,
      tomanTakerFeeBps: 0,
      maxResidualToman: 1_000,
      stopLossBps: 5_000,
      maxLossToman: 100_000,
      imbalance: { levels: 1, levelWeightDecayPercent: 70, minRatio: 2, exitRatio: 1.25, minVisibleDepthToman: 50_000, maxTopLevelSharePercent: 100, minMicropriceBiasBps: 0 }
    }, startedAt);
    const bnbOptions: MarketOptions = {
      amountSteps: { BNBUSDT: new Decimal("0.001") },
      priceSteps: { BNBUSDT: new Decimal(10) },
      minOrderRial: new Decimal(500_000),
      minOrderUsdt: new Decimal(5)
    };
    const heavy = [book("BNBUSDT", "BNB", 104_799_655, 105_101_112, 0.03, 0.01)];
    const lower = [book("BNBUSDT", "BNB", 103_000_000, 103_300_000, 0.01, 0.01, startedAt + 1_000)];
    const client = new MockClient([heavy, heavy, lower], (request, index) => {
      const price = request.side === "BUY" ? new Decimal(105_101_112) : new Decimal(103_000_000);
      const fee = request.side === "BUY" ? new Decimal("0.000005") : request.amountBase.mul(price).mul("0.0025").mul(10);
      return {
        id: `bnb-order-${index + 1}`,
        status: "Done",
        amount: request.amountBase,
        matchedAmount: request.amountBase,
        unmatchedAmount: new Decimal(0),
        totalPrice: request.amountBase.mul(price).mul(10),
        averagePrice: price.mul(10),
        fee,
        raw: { index }
      };
    }, bnbOptions);

    await expect(executeSpotPosition(plan, client, {}, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 }))
      .rejects.toMatchObject({ code: "UNTRADABLE_RESIDUAL", manualInterventionRequired: true });
    expect(client.placed.map(value => value.side)).toEqual(["BUY", "SELL"]);
    expect(client.placed[1]?.amountBase.toString()).toBe("0.001");
  });

  test("a confirmed partial entry is immediately recovered to USDT", async () => {
    const c = clock();
    const entryBooks = [book("XUSDT", "X", 99, 100, 3_000, 1_000)];
    const client = new MockClient([entryBooks, entryBooks, entryBooks], (request, index) => {
      const complete = filledOrder(request, index);
      if (index > 0) return complete;
      const matched = request.amountBase.mul("0.75");
      return { ...complete, status: "Canceled", matchedAmount: matched, unmatchedAmount: request.amountBase.minus(matched), totalPrice: matched.mul(91).mul(10) };
    });
    const result = await executeSpotPosition(imbalancePlan(), client, {}, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 });
    expect(result.status).toBe("recovered");
    expect(result.exitReason).toBe("partial-entry");
    expect(client.placed.map(value => value.side)).toEqual(["BUY", "SELL"]);
  });

  test("a server stop still uses the wider recovery envelope when the normal exit spread is unsafe", async () => {
    const c = clock();
    const entryBooks = [book("XUSDT", "X", 99, 100, 3_000, 1_000)];
    const unsafeNormalExit = [book("XUSDT", "X", 90, 100, 1_000, 1_000, startedAt + 1_000)];
    const recoveryBooks = [book("XUSDT", "X", 90, 100, 1_000, 1_000, startedAt + 1_000)];
    const client = new MockClient([entryBooks, entryBooks, unsafeNormalExit, recoveryBooks]);
    const result = await executeSpotPosition(imbalancePlan(), client, {
      onPositionCheck: () => "emergency-stop-active"
    }, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 });
    expect(result.status).toBe("recovered");
    expect(result.exitReason).toBe("risk-control");
    expect(result.legs.map(value => value.stage)).toEqual(["entry", "recovery"]);
  });

  test("an ambiguous entry fails closed and never submits a speculative recovery SELL", async () => {
    const c = clock();
    const books = [book("XUSDT", "X", 99, 100, 3_000, 1_000)];
    const client = new MockClient([books, books], () => { throw new Error("socket timeout"); });
    try {
      await executeSpotPosition(imbalancePlan(), client, {}, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SpotPositionExecutionError);
      expect(error).toMatchObject({ code: "ORDER_STATE_UNKNOWN", manualInterventionRequired: true });
    }
    expect(client.placed).toHaveLength(1);
  });

  test("reconciles a timed-out Spot submission by clientOrderId before continuing", async () => {
    const c = clock();
    const entry = [book("XUSDT", "X", 99, 100, 3_000, 1_000)];
    const converged = [book("XUSDT", "X", 102, 103, 1_000, 1_000, startedAt + 1_000)];
    let submissions = 0;
    let lookups = 0;
    const client = new MockClient([entry, entry, converged], (request, index) => {
      submissions += 1;
      if (submissions === 1) throw new Error("response timed out after acceptance");
      return filledOrder(request, index);
    });
    client.getOrderStatusByClientOrderId = async clientOrderId => {
      lookups += 1;
      expect(clientOrderId).toBe(client.placed[0]?.clientOrderId);
      return filledOrder(client.placed[0]!, 0);
    };

    const result = await executeSpotPosition(imbalancePlan(), client, {}, { now: c.now, sleep: c.sleep, revalidationDelayMs: 0 });
    expect(result.status).toBe("completed");
    expect(result.legs.map(value => value.orderId)).toEqual(["order-1", "order-2"]);
    expect(lookups).toBe(1);
  });
});
