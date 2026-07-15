import type { Opportunity } from "./bot/types";

export function serializeOpportunity(o: Opportunity) {
  return {
    id: o.id, route: o.route, requestedInputToman: o.requestedInputToman.toString(), inputToman: o.inputToman.toString(), outputToman: o.outputToman.toString(),
    netProfitToman: o.netProfitToman.toString(), profitBps: o.profitBps.toString(), executable: o.executable,
    liquiditySafe: o.liquiditySafe, sizedByDepth: o.sizedByDepth, sizingMode: o.sizingMode, rejectionReason: o.rejectionReason, scannedAt: o.scannedAt,
    legs: o.legs.map(l => ({ symbol: l.edge.book.symbol, from: l.edge.from, to: l.edge.to, side: l.edge.side,
      input: l.input.toString(), output: l.output.toString(), averagePrice: l.averagePrice.toString(), levelsUsed: l.levelsUsed,
      totalLevels: l.totalLevels, bestPrice: l.bestPrice.toString(), worstPrice: l.worstPrice.toString(),
      priceImpactBps: l.priceImpactBps.toString(), spreadBps: l.spreadBps.toString(),
      availableInput: l.availableInput.toString(), depthConsumedPercent: l.depthConsumedPercent.toString() }))
  };
}
