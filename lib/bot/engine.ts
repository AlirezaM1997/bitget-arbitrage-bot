import Decimal from "decimal.js";
import { defaultBotSettings } from "@/lib/bot-settings";
import type { Level, MarketOptions, OrderBook } from "@/lib/exchanges/types";
import type { ConversionEdge, LegQuote, Opportunity } from "./types";

const BPS = new Decimal(10_000);
const MAX_FUTURE_BOOK_SKEW_MS = 1_000;
const MAX_CROSS_BOOK_SKEW_MS = 1_000;
const MAX_DEPTH_BREAKPOINTS_PER_LEG = 24;
const DEPTH_BREAKPOINT_SEARCH_STEPS = 36;
const CAPITAL_FRACTIONS = [
  "1", "0.95", "0.9", "0.85", "0.8", "0.75", "0.7", "0.65", "0.6", "0.55",
  "0.5", "0.45", "0.4", "0.35", "0.3", "0.25", "0.2", "0.15", "0.1", "0.05", "0.025", "0.01"
];

type PathEvaluation = { opportunity: Opportunity; liquiditySafe: boolean };
export type ArbitrageSearchInput = {
  books: OrderBook[];
  capitalToman: Decimal.Value;
  options?: MarketOptions;
  now?: number;
  tomanFeeBps?: Decimal.Value;
  usdtFeeBps?: Decimal.Value;
  slippageBps?: Decimal.Value;
  maxPriceImpactBps?: Decimal.Value;
  maxSpreadBps?: Decimal.Value;
  depthUsagePercent?: Decimal.Value;
  minProfitBps?: Decimal.Value;
  minNetProfitToman?: Decimal.Value;
  /** Additional return required only while selecting a Live execution size. */
  liveSafetyBufferBps?: Decimal.Value;
  maxAgeMs?: number;
};
export type ArbitrageSearchStats = {
  triangleCount: number;
  evaluatedSizeCount: number;
  promisingPathCount: number;
  fastRejectedPathCount: number;
  refinedPathCount: number;
};
type EvaluationConfig = {
  now: number;
  options?: MarketOptions;
  tomanFeeBps: Decimal.Value;
  usdtFeeBps: Decimal.Value;
  slippageBps: Decimal.Value;
  maxPriceImpactBps: Decimal;
  maxSpreadBps: Decimal;
  depthUsagePercent: Decimal.Value;
  minProfitBps: Decimal;
  requiredProfitBps: Decimal;
  minNet: Decimal;
  maxAge: number;
};
type BookDepthView = {
  bids: Level[];
  asks: Level[];
  bidBaseCapacity: Decimal;
  askQuoteCapacity: Decimal;
  spreadBps: Decimal;
};
type CachedBookDepth = { version: string; view: BookDepthView };
const depthCache = new WeakMap<OrderBook, CachedBookDepth>();

export function buildEdges(books: OrderBook[]): ConversionEdge[] {
  return books.flatMap(book => {
    const base = book.base.trim().toUpperCase();
    const quote = book.quote.trim().toUpperCase();
    return [
      { id: `${book.symbol}:SELL`, from: base, to: quote, side: "SELL" as const, book },
      { id: `${book.symbol}:BUY`, from: quote, to: base, side: "BUY" as const, book }
    ];
  });
}

export function quoteEdge(
  edge: ConversionEdge,
  input: Decimal.Value,
  feeBps: Decimal.Value,
  slippageBps: Decimal.Value,
  depthUsagePercent: Decimal.Value = 100
): LegQuote | undefined {
  const amountIn = new Decimal(input);
  const depthRatio = new Decimal(depthUsagePercent).div(100);
  if (amountIn.lte(0) || depthRatio.lte(0) || depthRatio.gt(1)) return undefined;

  const depth = bookDepth(edge.book);
  const levels = edge.side === "SELL" ? depth.bids : depth.asks;
  if (!levels.length) return undefined;

  const availableInput = (edge.side === "SELL" ? depth.bidBaseCapacity : depth.askQuoteCapacity).mul(depthRatio);
  if (amountIn.gt(availableInput)) return undefined;

  let remaining = amountIn;
  let gross = new Decimal(0);
  let used = 0;
  let worstPrice = levels[0].price;

  for (const level of levels) {
    if (remaining.lte(0)) break;
    const usableBase = level.amount.mul(depthRatio);
    if (edge.side === "SELL") {
      const take = Decimal.min(remaining, usableBase);
      gross = gross.plus(take.mul(level.price));
      remaining = remaining.minus(take);
      if (take.gt(0)) { used += 1; worstPrice = level.price; }
    } else {
      const quoteCapacity = usableBase.mul(level.price);
      const spend = Decimal.min(remaining, quoteCapacity);
      gross = gross.plus(spend.div(level.price));
      remaining = remaining.minus(spend);
      if (spend.gt(0)) { used += 1; worstPrice = level.price; }
    }
  }

  if (remaining.gt(amountIn.mul("0.000000001")) || gross.lte(0)) return undefined;
  const fee = gross.mul(new Decimal(feeBps).div(BPS));
  const afterFee = gross.minus(fee);
  const slip = afterFee.mul(new Decimal(slippageBps).div(BPS));
  const output = afterFee.minus(slip);
  const averagePrice = edge.side === "SELL" ? gross.div(amountIn) : amountIn.div(gross);
  const bestPrice = levels[0].price;
  const priceImpactBps = edge.side === "SELL"
    ? bestPrice.minus(averagePrice).div(bestPrice).mul(BPS)
    : averagePrice.minus(bestPrice).div(bestPrice).mul(BPS);

  return {
    edge,
    input: amountIn,
    grossOutput: gross,
    output,
    averagePrice,
    fee,
    slippageBuffer: slip,
    levelsUsed: used,
    totalLevels: levels.length,
    bestPrice,
    worstPrice,
    priceImpactBps: Decimal.max(priceImpactBps, 0),
    spreadBps: depth.spreadBps,
    availableInput,
    depthConsumedPercent: amountIn.div(availableInput).mul(100)
  };
}

export function bookSpreadBps(book: OrderBook) {
  return bookDepth(book).spreadBps;
}

export function findTriangularOpportunities(input: ArbitrageSearchInput): Opportunity[] {
  return findTriangularOpportunitiesDetailed(input).opportunities;
}

export function findTriangularOpportunitiesDetailed(input: ArbitrageSearchInput): { opportunities: Opportunity[]; stats: ArbitrageSearchStats } {
  const now = input.now ?? Date.now();
  const requestedCapital = new Decimal(input.capitalToman);
  if (requestedCapital.lte(0)) return { opportunities: [], stats: { triangleCount: 0, evaluatedSizeCount: 0, promisingPathCount: 0, fastRejectedPathCount: 0, refinedPathCount: 0 } };

  const config = {
    now,
    options: input.options,
    tomanFeeBps: input.tomanFeeBps ?? defaultBotSettings.tomanTakerFeeBps,
    usdtFeeBps: input.usdtFeeBps ?? defaultBotSettings.usdtTakerFeeBps,
    slippageBps: input.slippageBps ?? defaultBotSettings.slippageBufferBps,
    maxPriceImpactBps: new Decimal(input.maxPriceImpactBps ?? defaultBotSettings.maxPriceImpactBps),
    maxSpreadBps: new Decimal(input.maxSpreadBps ?? defaultBotSettings.maxSpreadBps),
    depthUsagePercent: input.depthUsagePercent ?? defaultBotSettings.orderbookDepthUsagePercent,
    minProfitBps: new Decimal(input.minProfitBps ?? defaultBotSettings.minProfitBps),
    requiredProfitBps: new Decimal(input.minProfitBps ?? defaultBotSettings.minProfitBps)
      .plus(input.liveSafetyBufferBps ?? 0),
    minNet: new Decimal(input.minNetProfitToman ?? defaultBotSettings.minNetProfitToman),
    maxAge: input.maxAgeMs ?? defaultBotSettings.orderbookMaxAgeMs
  };

  const edges = buildEdges(input.books);
  const byFrom = new Map<string, ConversionEdge[]>();
  for (const edge of edges) byFrom.set(edge.from, [...(byFrom.get(edge.from) ?? []), edge]);
  const opportunities: Opportunity[] = [];
  const paths = triangularPaths(byFrom);
  const coarseCapitals = candidateCapitals(requestedCapital, input.options);
  let evaluatedSizeCount = 0;
  let promisingPathCount = 0;
  let fastRejectedPathCount = 0;
  let refinedPathCount = 0;

  for (const path of paths) {
    const optimisticRate = optimisticPathRate(path, config);
    if (!optimisticRate) continue;
    const spreadSafe = path.every(edge => bookSpreadBps(edge.book).lte(config.maxSpreadBps));
    const promising = optimisticRate.gt(1) && spreadSafe;
    if (promising) promisingPathCount += 1;
    else fastRejectedPathCount += 1;

    const evaluations: PathEvaluation[] = [];
    const capitals = promising
      ? mergeCapitals(
        coarseCapitals,
        depthBreakpointCapitals(path, requestedCapital, config)
      )
      : [...coarseCapitals].reverse();
    for (const capital of capitals) {
      evaluatedSizeCount += 1;
      const evaluation = evaluatePath(path, capital, requestedCapital, config);
      if (evaluation) evaluations.push(evaluation);
      if (!promising && evaluation) break;
    }
    if (!evaluations.length) continue;

    let selected = selectBestEvaluation(evaluations);
    if (promising && selected.liquiditySafe && selected.opportunity.netProfitToman.gt(0)) {
      const refinements = refinementCapitals(selected.opportunity.inputToman, requestedCapital, input.options, capitals);
      if (refinements.length) refinedPathCount += 1;
      for (const capital of refinements) {
        evaluatedSizeCount += 1;
        const evaluation = evaluatePath(path, capital, requestedCapital, config);
        if (evaluation) evaluations.push(evaluation);
      }
      selected = selectBestEvaluation(evaluations);
    }
    selected.opportunity.sizingMode = promising ? "optimized" : "diagnostic-minimum";
    opportunities.push(selected.opportunity);
  }

  const sorted = opportunities.sort((a, b) => {
    if (a.executable !== b.executable) return a.executable ? -1 : 1;
    if (a.liquiditySafe !== b.liquiditySafe) return a.liquiditySafe ? -1 : 1;
    return b.profitBps.comparedTo(a.profitBps);
  });
  return {
    opportunities: sorted,
    stats: { triangleCount: paths.length, evaluatedSizeCount, promisingPathCount, fastRejectedPathCount, refinedPathCount }
  };
}

function evaluatePath(
  path: [ConversionEdge, ConversionEdge, ConversionEdge],
  capital: Decimal,
  requestedCapital: Decimal,
  config: EvaluationConfig
): PathEvaluation | undefined {
  if (!pathBooksAreExecutable(path, config)) return undefined;
  const legs: LegQuote[] = [];
  let current = capital;
  let liquiditySafe = true;
  let reason: string | undefined;

  for (const edge of path) {
    if (!bookIsFresh(edge.book, config.now, config.maxAge)) return undefined;
    if (config.options && !hasOfficialPrecision(edge.book.symbol, config.options)) return undefined;
    const quote = quoteEdge(
      edge,
      current,
      feeBpsForEdge(edge, config),
      config.slippageBps,
      config.depthUsagePercent
    );
    if (!quote) return undefined;

    if (quote.spreadBps.gt(config.maxSpreadBps)) {
      liquiditySafe = false;
      reason ??= `اسپرد ${edge.book.symbol} زیاد است (${quote.spreadBps.div(100).toFixed(3)}٪)`;
    }
    if (quote.priceImpactBps.gt(config.maxPriceImpactBps)) {
      liquiditySafe = false;
      reason ??= `اثر قیمت ${edge.book.symbol} زیاد است (${quote.priceImpactBps.div(100).toFixed(3)}٪)`;
    }
    if (config.options && !meetsMinimum(quote, config.options, path)) {
      liquiditySafe = false;
      reason ??= `حداقل سفارش ${edge.book.symbol} رعایت نمی‌شود`;
    }

    legs.push(quote);
    current = quote.output;
  }

  const profit = current.minus(capital);
  const profitBps = profit.div(capital).mul(BPS);
  const executable = liquiditySafe && profit.gte(config.minNet) && profitBps.gte(config.requiredProfitBps);
  if (!reason && !executable) {
    reason = profit.lt(config.minNet)
      ? `سود خالص ${profit.toFixed(2)} USDT کمتر از حداقل تاریخی ${config.minNet.toFixed(2)} USDT است`
      : `بازده ${profitBps.toFixed(2)} BPS کمتر از حداقل اجرای ${config.requiredProfitBps.toFixed(2)} BPS است`;
  }

  const [first, second, third] = path;
  return {
    liquiditySafe,
    opportunity: {
      id: [first.id, second.id, third.id].join("|"),
      route: ["USDT", first.to, second.to, "USDT"],
      legs,
      requestedInputToman: requestedCapital,
      inputToman: capital,
      outputToman: current,
      netProfitToman: profit,
      profitBps,
      liquiditySafe,
      executable,
      rejectionReason: reason,
      sizedByDepth: capital.lt(requestedCapital),
      sizingMode: "optimized",
      scannedAt: config.now
    }
  };
}

function selectBestEvaluation(evaluations: PathEvaluation[]) {
  // A smaller size that clears all Live gates is preferable to a larger size
  // with more absolute profit that cannot actually be submitted.
  const executable = evaluations.filter(item => item.opportunity.executable);
  if (executable.length) {
    return [...executable].sort((a, b) => b.opportunity.netProfitToman.comparedTo(a.opportunity.netProfitToman))[0];
  }
  const safe = evaluations.filter(item => item.liquiditySafe);
  const safeProfitable = safe.filter(item => item.opportunity.netProfitToman.gt(0));
  const pool = safeProfitable.length ? safeProfitable : safe.length ? safe : evaluations;
  return [...pool].sort((a, b) => {
    if (safeProfitable.length) return b.opportunity.netProfitToman.comparedTo(a.opportunity.netProfitToman);
    return b.opportunity.profitBps.comparedTo(a.opportunity.profitBps);
  })[0];
}

function optimisticPathRate(path: [ConversionEdge, ConversionEdge, ConversionEdge], config: EvaluationConfig) {
  if (!pathBooksAreExecutable(path, config)) return undefined;
  let rate = new Decimal(1);
  const slippageRetention = new Decimal(1).minus(new Decimal(config.slippageBps).div(BPS));
  if (slippageRetention.lte(0)) return undefined;
  for (const edge of path) {
    if (!bookIsFresh(edge.book, config.now, config.maxAge)) return undefined;
    if (config.options && !hasOfficialPrecision(edge.book.symbol, config.options)) return undefined;
    const price = executableLevels(edge)[0]?.price;
    if (!price || price.lte(0)) return undefined;
    const feeBps = feeBpsForEdge(edge, config);
    const feeRetention = new Decimal(1).minus(new Decimal(feeBps).div(BPS));
    if (feeRetention.lte(0)) return undefined;
    const conversion = edge.side === "SELL" ? price : new Decimal(1).div(price);
    rate = rate.mul(conversion).mul(feeRetention).mul(slippageRetention);
  }
  return rate;
}

function refinementCapitals(selected: Decimal, requested: Decimal, options: MarketOptions | undefined, coarse: Decimal[]) {
  const step = requested.mul("0.005");
  if (step.lte(0)) return [];
  const minimum = minimumCapital(requested, options);
  const low = Decimal.max(minimum, selected.minus(requested.mul("0.05")));
  const high = Decimal.min(requested, selected.plus(requested.mul("0.05")));
  const existing = new Set(coarse.map(value => value.toSignificantDigits(18).toString()));
  const refinements: Decimal[] = [];
  for (let value = low; value.lte(high); value = value.plus(step)) {
    const key = value.toSignificantDigits(18).toString();
    if (!existing.has(key)) {
      existing.add(key);
      refinements.push(value);
    }
  }
  return refinements;
}

function triangularPaths(byFrom: Map<string, ConversionEdge[]>): Array<[ConversionEdge, ConversionEdge, ConversionEdge]> {
  const paths: Array<[ConversionEdge, ConversionEdge, ConversionEdge]> = [];
  for (const first of byFrom.get("USDT") ?? []) {
    for (const second of byFrom.get(first.to) ?? []) {
      if (second.to === "USDT" || second.to === first.from || second.book.symbol === first.book.symbol) continue;
      for (const third of byFrom.get(second.to) ?? []) {
        if (third.to !== "USDT" || new Set([first.book.symbol, second.book.symbol, third.book.symbol]).size !== 3) continue;
        paths.push([first, second, third]);
      }
    }
  }
  return paths;
}

function candidateCapitals(capital: Decimal, options?: MarketOptions) {
  const minimum = minimumCapital(capital, options);
  const candidates = CAPITAL_FRACTIONS
    .map(fraction => capital.mul(fraction))
    .filter(value => value.gte(minimum));
  if (capital.gte(minimum)) candidates.push(minimum);
  if (!candidates.length) candidates.push(capital);

  const unique = new Map<string, Decimal>();
  for (const value of candidates) unique.set(value.toSignificantDigits(18).toString(), value);
  return [...unique.values()].sort((a, b) => b.comparedTo(a));
}

/**
 * Adds the exact input sizes where any leg starts consuming the next orderbook
 * level. Profit is piecewise linear between those boundaries, so evaluating
 * only fixed percentages can miss the best executable size. Later-leg depth
 * boundaries are mapped back to the initial USDT capital with a monotonic
 * search through the preceding legs.
 */
function depthBreakpointCapitals(
  path: [ConversionEdge, ConversionEdge, ConversionEdge],
  requested: Decimal,
  config: EvaluationConfig
) {
  const minimum = minimumCapital(requested, config.options);
  const capitals: Decimal[] = [];

  for (let legIndex = 0; legIndex < path.length; legIndex += 1) {
    const reachable = maximumReachablePrefix(path, legIndex, minimum, requested, config);
    if (!reachable) continue;
    const thresholds = sampleDepthBreakpoints(
      inputDepthBreakpoints(path[legIndex], config.depthUsagePercent, reachable.output),
      MAX_DEPTH_BREAKPOINTS_PER_LEG
    );

    for (const threshold of thresholds) {
      const capital = legIndex === 0
        ? threshold
        : capitalForPrefixInput(path, legIndex, threshold, minimum, reachable.capital, config);
      if (capital && capital.gte(minimum) && capital.lte(requested)) capitals.push(capital);
    }
  }

  return mergeCapitals(capitals);
}

function maximumReachablePrefix(
  path: [ConversionEdge, ConversionEdge, ConversionEdge],
  legIndex: number,
  minimum: Decimal,
  requested: Decimal,
  config: EvaluationConfig
) {
  const requestedOutput = prefixInputAtCapital(path, legIndex, requested, config);
  if (requestedOutput) return { capital: requested, output: requestedOutput };

  let low = minimum;
  let lowOutput = prefixInputAtCapital(path, legIndex, low, config);
  if (!lowOutput) return undefined;
  let high = requested;
  for (let iteration = 0; iteration < DEPTH_BREAKPOINT_SEARCH_STEPS; iteration += 1) {
    const middle = low.plus(high).div(2);
    const output = prefixInputAtCapital(path, legIndex, middle, config);
    if (output) {
      low = middle;
      lowOutput = output;
    } else {
      high = middle;
    }
  }
  return { capital: low, output: lowOutput };
}

function capitalForPrefixInput(
  path: [ConversionEdge, ConversionEdge, ConversionEdge],
  legIndex: number,
  target: Decimal,
  minimum: Decimal,
  maximum: Decimal,
  config: EvaluationConfig
) {
  const minimumOutput = prefixInputAtCapital(path, legIndex, minimum, config);
  const maximumOutput = prefixInputAtCapital(path, legIndex, maximum, config);
  if (!minimumOutput || !maximumOutput || target.lt(minimumOutput) || target.gt(maximumOutput)) return undefined;
  if (target.eq(minimumOutput)) return minimum;
  if (target.eq(maximumOutput)) return maximum;

  let low = minimum;
  let high = maximum;
  for (let iteration = 0; iteration < DEPTH_BREAKPOINT_SEARCH_STEPS; iteration += 1) {
    const middle = low.plus(high).div(2);
    const output = prefixInputAtCapital(path, legIndex, middle, config);
    if (!output || output.gt(target)) high = middle;
    else low = middle;
  }
  // Stay infinitesimally below the mapped boundary; returning the midpoint
  // could cross into the next, worse level because of numerical tolerance.
  return low;
}

function prefixInputAtCapital(
  path: [ConversionEdge, ConversionEdge, ConversionEdge],
  legIndex: number,
  capital: Decimal,
  config: EvaluationConfig
) {
  let current = capital;
  for (let index = 0; index < legIndex; index += 1) {
    const edge = path[index];
    const quote = quoteEdge(
      edge,
      current,
      feeBpsForEdge(edge, config),
      config.slippageBps,
      config.depthUsagePercent
    );
    if (!quote) return undefined;
    current = quote.output;
  }
  return current;
}

function inputDepthBreakpoints(
  edge: ConversionEdge,
  depthUsagePercent: Decimal.Value,
  maximumInput: Decimal
) {
  const ratio = new Decimal(depthUsagePercent).div(100);
  if (ratio.lte(0) || ratio.gt(1)) return [];
  const levels = executableLevels(edge);
  const boundaries: Decimal[] = [];
  let cumulative = new Decimal(0);
  for (const level of levels) {
    const inputCapacity = edge.side === "SELL"
      ? level.amount.mul(ratio)
      : level.amount.mul(level.price).mul(ratio);
    cumulative = cumulative.plus(inputCapacity);
    if (cumulative.gt(maximumInput)) break;
    boundaries.push(cumulative);
  }
  return boundaries;
}

function sampleDepthBreakpoints(values: Decimal[], limit: number) {
  if (values.length <= limit) return values;
  const selected: Decimal[] = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(values[Math.round(index * (values.length - 1) / (limit - 1))]);
  }
  return selected;
}

function mergeCapitals(...groups: Decimal[][]) {
  const unique = new Map<string, Decimal>();
  for (const capital of groups.flat()) {
    if (!capital.isFinite() || capital.lte(0)) continue;
    unique.set(capital.toSignificantDigits(18).toString(), capital);
  }
  return [...unique.values()].sort((a, b) => b.comparedTo(a));
}

function minimumCapital(capital: Decimal, options?: MarketOptions) {
  if (!options) return Decimal.min(capital, Decimal.max(capital.mul("0.01"), 1));
  const official = Object.values(options.minTradeUsdtBySymbol ?? {})
    .filter(value => value.isFinite() && value.gt(0));
  const fallback = options.minOrderUsdt?.isFinite() && options.minOrderUsdt.gt(0)
    ? options.minOrderUsdt
    : new Decimal(1);
  const minimum = official.length ? Decimal.min(...official) : fallback;
  return Decimal.min(capital, minimum);
}

function executableLevels(edge: Pick<ConversionEdge, "side" | "book">): Level[] {
  const depth = bookDepth(edge.book);
  return edge.side === "SELL" ? depth.bids : depth.asks;
}

function bookDepth(book: OrderBook): BookDepthView {
  const version = bookDepthVersion(book);
  const cached = depthCache.get(book);
  if (cached?.version === version) return cached.view;
  const bids = book.bids
    .filter(level => level.price.gt(0) && level.amount.gt(0))
    .map(level => ({ price: new Decimal(level.price), amount: new Decimal(level.amount) }))
    .sort((a, b) => b.price.comparedTo(a.price));
  const asks = book.asks
    .filter(level => level.price.gt(0) && level.amount.gt(0))
    .map(level => ({ price: new Decimal(level.price), amount: new Decimal(level.amount) }))
    .sort((a, b) => a.price.comparedTo(b.price));
  const bidBaseCapacity = bids.reduce((total, level) => total.plus(level.amount), new Decimal(0));
  const askQuoteCapacity = asks.reduce((total, level) => total.plus(level.amount.mul(level.price)), new Decimal(0));
  const bid = bids[0]?.price;
  const ask = asks[0]?.price;
  const crossed = Boolean(bid && ask && bid.gte(ask));
  const spreadBps = !bid || !ask || bid.lte(0) || ask.lte(0) || crossed
    ? new Decimal(1_000_000)
    : ask.minus(bid).div(bid.plus(ask).div(2)).mul(BPS);
  const view = {
    bids: crossed ? [] : bids,
    asks: crossed ? [] : asks,
    bidBaseCapacity: crossed ? new Decimal(0) : bidBaseCapacity,
    askQuoteCapacity: crossed ? new Decimal(0) : askQuoteCapacity,
    spreadBps
  };
  depthCache.set(book, { version, view });
  return view;
}

function bookDepthVersion(book: OrderBook) {
  const levels = (side: "b" | "a", values: Level[]) => values
    .map(level => `${side}:${level.price.toString()}:${level.amount.toString()}`)
    .join("|");
  return `${book.lastUpdate}|${levels("b", book.bids)}|${levels("a", book.asks)}`;
}

function meetsMinimum(
  leg: LegQuote,
  options: MarketOptions,
  path: [ConversionEdge, ConversionEdge, ConversionEdge]
) {
  const amountStep = marketStep(options.amountSteps, leg.edge.book.symbol);
  if (!amountStep) return false;
  const rawBase = leg.edge.side === "BUY" ? leg.grossOutput : leg.input;
  const roundedBase = rawBase.div(amountStep).floor().mul(amountStep);
  if (roundedBase.lte(0)) return false;
  // Conservative lower bound after amount-step rounding.
  const quoteAmount = roundedBase.mul(leg.edge.side === "BUY" ? leg.bestPrice : leg.worstPrice);
  const quoteMinimum = positiveMarketOption(options.minOrderQuoteBySymbol, leg.edge.book.symbol);
  if (quoteMinimum) return quoteAmount.gte(quoteMinimum);

  const usdtMinimum = positiveMarketOption(options.minTradeUsdtBySymbol, leg.edge.book.symbol)
    ?? positiveDecimal(options.minOrderUsdt);
  if (!usdtMinimum) return false;
  const usdtValue = conservativeUsdtValue(
    leg.edge.book.quote,
    quoteAmount,
    path.map(edge => edge.book)
  );
  return Boolean(usdtValue?.gte(usdtMinimum));
}

function conservativeUsdtValue(asset: string, amount: Decimal, books: OrderBook[]) {
  const normalized = asset.trim().toUpperCase();
  if (normalized === "USDT") return amount;
  const values: Decimal[] = [];
  for (const book of books) {
    const base = book.base.trim().toUpperCase();
    const quote = book.quote.trim().toUpperCase();
    const depth = bookDepth(book);
    if (base === normalized && quote === "USDT" && depth.bids[0]) {
      values.push(amount.mul(depth.bids[0].price));
    } else if (base === "USDT" && quote === normalized && depth.asks[0]) {
      values.push(amount.div(depth.asks[0].price));
    }
  }
  return values.length ? Decimal.min(...values) : undefined;
}

function feeBpsForEdge(edge: Pick<ConversionEdge, "book">, config: EvaluationConfig) {
  return nonNegativeMarketOption(config.options?.takerFeeBpsBySymbol, edge.book.symbol)
    ?? (edge.book.quote.trim().toUpperCase() === "USDT" ? config.tomanFeeBps : config.usdtFeeBps);
}

function positiveMarketOption(values: Record<string, Decimal> | undefined, symbol: string) {
  if (!values) return undefined;
  return positiveDecimal(values[symbol] ?? values[symbol.toUpperCase()]);
}

function positiveDecimal(value: Decimal | undefined) {
  return value?.isFinite() && value.gt(0) ? value : undefined;
}

function nonNegativeMarketOption(values: Record<string, Decimal> | undefined, symbol: string) {
  if (!values) return undefined;
  const value = values[symbol] ?? values[symbol.toUpperCase()];
  return value?.isFinite() && value.gte(0) ? value : undefined;
}

function pathBooksAreExecutable(
  path: [ConversionEdge, ConversionEdge, ConversionEdge],
  config: Pick<EvaluationConfig, "now" | "maxAge">
) {
  const timestamps = path.map(edge => edge.book.lastUpdate);
  if (path.some(edge => !bookIsFresh(edge.book, config.now, config.maxAge))) return false;
  return Math.max(...timestamps) - Math.min(...timestamps) <= Math.min(config.maxAge, MAX_CROSS_BOOK_SKEW_MS);
}

function bookIsFresh(book: OrderBook, now: number, maxAgeMs: number) {
  return Number.isFinite(book.lastUpdate)
    && book.lastUpdate > 0
    && now - book.lastUpdate <= maxAgeMs
    && book.lastUpdate - now <= MAX_FUTURE_BOOK_SKEW_MS;
}

function hasOfficialPrecision(symbol: string, options: MarketOptions) {
  return Boolean(marketStep(options.amountSteps, symbol) && marketStep(options.priceSteps, symbol));
}

function marketStep(steps: Record<string, Decimal>, symbol: string) {
  const step = steps[symbol] ?? steps[symbol.toUpperCase()];
  return step?.isFinite() && step.gt(0) ? step : undefined;
}
