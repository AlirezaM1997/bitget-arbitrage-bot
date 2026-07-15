import Decimal from "decimal.js";
import type { BotSettings } from "@/lib/bot-settings";
import { bitgetClientSettings } from "@/lib/bitget-runtime-settings";
import { BitgetClient } from "@/lib/exchanges/bitget";
import { findTriangularOpportunitiesDetailed } from "./engine";

export async function scan(
  capitalToman: Decimal.Value,
  settings: BotSettings,
  client = new BitgetClient(bitgetClientSettings(settings))
) {
  const [discoveryBooks, options, symbols, relevantSymbols] = await Promise.all([
    client.getTriangleScanOrderBooks(),
    client.getMarketOptions(),
    client.getSymbols(),
    client.getTriangleSymbols()
  ]);
  const engineStartedAt = performance.now();
  const preliminary = evaluate(discoveryBooks, options, capitalToman, settings);
  const refinementSymbols = fullMarketRefinementSymbols(preliminary.opportunities);
  const deepBooks = await client.getOrderBooksForSymbols(refinementSymbols);
  const deepBySymbol = new Map(deepBooks.map(book => [book.symbol, book]));
  const books = discoveryBooks.map(book => deepBySymbol.get(book.symbol) ?? book);
  const { opportunities, stats } = deepBooks.length
    ? evaluate(books, options, capitalToman, settings)
    : preliminary;
  return {
    scannedAt: Date.now(),
    capitalToman: new Decimal(capitalToman),
    exchangeMarketCount: symbols.filter(symbol => symbol.status === "online").length,
    relevantMarketCount: relevantSymbols.length,
    marketCount: books.length,
    depthRefinedMarketCount: deepBooks.length,
    executableCount: opportunities.filter(o => o.executable).length,
    positiveCount: opportunities.filter(o => o.netProfitToman.gt(0)).length,
    liquiditySafePositiveCount: opportunities.filter(o => o.netProfitToman.gt(0) && o.liquiditySafe).length,
    engineMs: Math.round(performance.now() - engineStartedAt),
    ...stats,
    opportunities,
    books,
    options
  };
}

export function fullMarketRefinementSymbols(opportunities: Array<{
  netProfitToman: Decimal;
  legs: Array<{ edge: { book: { symbol: string } } }>;
}>) {
  return [...new Set(opportunities
    .filter(opportunity => opportunity.netProfitToman.gt(0))
    .flatMap(opportunity => opportunity.legs.map(leg => leg.edge.book.symbol)))];
}

function evaluate(
  books: Awaited<ReturnType<BitgetClient["getTriangleScanOrderBooks"]>>,
  options: Awaited<ReturnType<BitgetClient["getMarketOptions"]>>,
  capitalToman: Decimal.Value,
  settings: BotSettings
) {
  return findTriangularOpportunitiesDetailed({
    books, options, capitalToman,
    tomanFeeBps: settings.tomanTakerFeeBps,
    usdtFeeBps: settings.usdtTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    maxPriceImpactBps: settings.maxPriceImpactBps,
    maxSpreadBps: settings.maxSpreadBps,
    depthUsagePercent: settings.orderbookDepthUsagePercent,
    minProfitBps: settings.minProfitBps,
    minNetProfitToman: settings.minNetProfitToman,
    maxAgeMs: settings.orderbookMaxAgeMs
  });
}

export async function liveCapital(
  settings: BotSettings,
  client = new BitgetClient(bitgetClientSettings(settings))
) {
  // Keep Live sizing on Bitget's available Spot USDT balance only.
  const wallet = await client.getSpotUsdtWallet();
  if (!wallet) throw new Error("Spot USDT balance was not returned by Bitget");
  const usable = wallet.available.mul(settings.balanceUsagePercent).div(100);
  return Decimal.min(usable, settings.maxTradeToman);
}
