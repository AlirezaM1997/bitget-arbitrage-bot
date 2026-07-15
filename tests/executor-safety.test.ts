import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { defaultBotSettings } from "@/lib/bot-settings";
import { quoteEdge } from "@/lib/bot/engine";
import {
  priceToOutwardStep,
  protectedMarketOrder,
  safeOrderAmountBase,
  submitOrReconcile,
  type LiveExecutionClient
} from "@/lib/bot/executor";
import type { BitgetOrder, OrderBook } from "@/lib/exchanges/types";

const now = Date.now();
const orderBook = (): OrderBook => ({
  symbol: "BTCUSDT",
  base: "BTC",
  quote: "USDT",
  lastUpdate: now,
  bids: [{ price: new Decimal(99), amount: new Decimal(100) }],
  asks: [
    { price: new Decimal(100), amount: new Decimal(5) },
    { price: new Decimal(101), amount: new Decimal(5) }
  ]
});

const acceptedOrder: BitgetOrder = {
  id: "42",
  status: "filled",
  amount: new Decimal(1),
  matchedAmount: new Decimal(1),
  unmatchedAmount: new Decimal(0),
  totalPrice: new Decimal(100),
  averagePrice: new Decimal(100),
  fee: new Decimal(0),
  raw: {}
};

function submissionClient(overrides: Partial<LiveExecutionClient>): LiveExecutionClient {
  return {
    getAllOrderBooks: async () => [],
    getMarketOptions: async () => ({ amountSteps: {}, priceSteps: {}, minOrderRial: new Decimal(1), minOrderUsdt: new Decimal(1) }),
    placeMarketOrder: async () => acceptedOrder,
    getOrderStatus: async () => acceptedOrder,
    cancelOrder: async () => undefined,
    ...overrides
  };
}

describe("protected Bitget market orders", () => {
  test("anchors protection to the worst consumed level and rounds ticks outward", () => {
    const book = orderBook();
    const edge = { id: "BTCUSDT:BUY", from: "USDT", to: "BTC", side: "BUY" as const, book };
    const quote = quoteEdge(edge, 1_005, 0, 0, 100)!;
    expect(quote.averagePrice.lt(quote.worstPrice)).toBe(true);

    const protection = protectedMarketOrder(quote, new Decimal("0.1"), {
      ...defaultBotSettings,
      slippageBufferBps: 0
    });

    expect(protection.expectedPrice.toString()).toBe("101");
    expect(protection.maximumBuyFillPrice.toString()).toBe("101");
    expect(quote.worstPrice.lte(protection.maximumBuyFillPrice)).toBe(true);
    const buffered = protectedMarketOrder(quote, new Decimal("0.1"), {
      ...defaultBotSettings,
      slippageBufferBps: 10
    });
    expect(buffered.expectedPrice.toString()).toBe("101.2");
    expect(priceToOutwardStep("BUY", new Decimal("10.01"), new Decimal(1)).toString()).toBe("11");
    expect(priceToOutwardStep("SELL", new Decimal("10.99"), new Decimal(1)).toString()).toBe("10");
  });

  test("sizes BUY reserve from the protected fill boundary, never from the Live profit buffer", () => {
    const book = orderBook();
    const edge = { id: "BTCUSDT:BUY", from: "USDT", to: "BTC", side: "BUY" as const, book };
    const quote = quoteEdge(edge, 1_005, 0, 0, 100)!;
    const lowProfitBuffer = protectedMarketOrder(quote, new Decimal("0.1"), {
      ...defaultBotSettings, slippageBufferBps: 0, liveSafetyBufferBps: 0
    });
    const highProfitBuffer = protectedMarketOrder(quote, new Decimal("0.1"), {
      ...defaultBotSettings, slippageBufferBps: 0, liveSafetyBufferBps: 5_000
    });
    const first = safeOrderAmountBase("BUY", new Decimal(1_005), quote, new Decimal("0.001"), lowProfitBuffer.maximumBuyFillPrice);
    const second = safeOrderAmountBase("BUY", new Decimal(1_005), quote, new Decimal("0.001"), highProfitBuffer.maximumBuyFillPrice);

    expect(first.toString()).toBe("9.95");
    expect(second.toString()).toBe(first.toString());
  });
});

describe("ambiguous submission reconciliation", () => {
  test("recovers an accepted order by clientOrderId after the add-order response times out", async () => {
    let reconciliations = 0;
    const client = submissionClient({
      placeMarketOrder: async () => { throw new Error("socket timeout after upload"); },
      getOrderStatusByClientOrderId: async (clientOrderId: string) => {
        reconciliations += 1;
        expect(clientOrderId).toBe("tri-known-id");
        return acceptedOrder;
      }
    });

    const result = await submitOrReconcile(client, {
      side: "BUY", base: "BTC", quote: "USDT", amountBase: new Decimal(1),
      expectedPrice: new Decimal(100), clientOrderId: "tri-known-id"
    }, "submission:BTCUSDT:0");

    expect(result.id).toBe("42");
    expect(reconciliations).toBe(1);
  });

  test("does not reconcile or retry a definitive exchange rejection", async () => {
    let reconciliations = 0;
    const client = submissionClient({
      placeMarketOrder: async () => { throw new Error("Order rejected: InvalidMarket - bad order"); },
      getOrderStatusByClientOrderId: async () => { reconciliations += 1; return acceptedOrder; }
    });

    let message = "";
    try {
      await submitOrReconcile(client, {
        side: "BUY", base: "BTC", quote: "USDT", amountBase: new Decimal(1),
        expectedPrice: new Decimal(100), clientOrderId: "tri-rejected"
      }, "submission:BTCUSDT:0");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Order rejected:");
    expect(reconciliations).toBe(0);
  });
});
