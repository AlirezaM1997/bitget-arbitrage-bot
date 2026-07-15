import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { fullMarketRefinementSymbols } from "@/lib/bot/scanner";

describe("full-market triangular scan", () => {
  test("does not cap deep refinement to the first twelve positive cycles", () => {
    const opportunities = Array.from({ length: 20 }, (_, index) => ({
      netProfitToman: new Decimal(1),
      legs: [0, 1, 2].map(leg => ({
        edge: { book: { symbol: `MARKET_${index}_${leg}` } }
      }))
    }));

    const symbols = fullMarketRefinementSymbols(opportunities);

    expect(symbols).toHaveLength(60);
    expect(symbols).toContain("MARKET_19_2");
  });

  test("ignores non-positive cycles and de-duplicates shared markets", () => {
    const symbols = fullMarketRefinementSymbols([
      { netProfitToman: new Decimal(2), legs: [{ edge: { book: { symbol: "BTCUSDT" } } }, { edge: { book: { symbol: "ETHBTC" } } }, { edge: { book: { symbol: "ETHUSDT" } } }] },
      { netProfitToman: new Decimal(1), legs: [{ edge: { book: { symbol: "BTCUSDT" } } }, { edge: { book: { symbol: "SOLBTC" } } }, { edge: { book: { symbol: "SOLUSDT" } } }] },
      { netProfitToman: new Decimal(0), legs: [{ edge: { book: { symbol: "IGNORED" } } }] }
    ]);

    expect(symbols).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT", "SOLBTC", "SOLUSDT"]);
  });
});
