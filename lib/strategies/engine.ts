import Decimal from "decimal.js";
import type { OrderBook } from "@/lib/exchanges/types";
import { bookSpreadBps, quoteEdge } from "@/lib/bot/engine";
import type { StrategyLabConfig, StrategyLabContext, StrategyLabScanResult, StrategySignal } from "./types";
import { measureOrderbookImbalance, summarizeSnapshotOrderFlow } from "./orderbook-imbalance";
import { scanOrderbookGaps } from "./orderbook-gap";

const BPS = new Decimal(10_000);

export function scanStrategyLab(books: OrderBook[], config: StrategyLabConfig, context: StrategyLabContext = {}): StrategyLabScanResult {
  const now = context.now ?? Date.now();
  const signals: StrategySignal[] = [];
  if (!config.settings.enabled) return { scannedAt: now, signals, actionableCount: 0, watchCount: 0, enabledCount: 0, diagnostics: { disabled: true } };

  if (config.settings.gapTrading.enabled) signals.push(...scanOrderbookGaps(books, config, now, context));
  if (config.settings.imbalance.enabled) signals.push(...scanOrderbookImbalance(books, config, now, context));

  signals.sort((a, b) => {
    const rank = { actionable: 2, watch: 1, blocked: 0 };
    if (rank[a.status] !== rank[b.status]) return rank[b.status] - rank[a.status];
    return b.confidence.comparedTo(a.confidence) || b.expectedEdgeBps.comparedTo(a.expectedEdgeBps);
  });
  return {
    scannedAt: now,
    signals: signals.slice(0, 100),
    actionableCount: signals.filter(item => item.status === "actionable").length,
    watchCount: signals.filter(item => item.status === "watch").length,
    enabledCount: [config.settings.gapTrading.enabled, config.settings.imbalance.enabled].filter(Boolean).length,
    diagnostics: { marketCount: books.length, paperOnly: true }
  };
}

export function scanOrderbookImbalance(books: OrderBook[], config: StrategyLabConfig, now = Date.now(), context: StrategyLabContext = {}) {
  const settings = config.settings.imbalance;
  const usdtIrt = books.find(book => book.symbol === "USDTUSDT");
  const usdtToman = usdtIrt && mid(usdtIrt);
  const signals: StrategySignal[] = [];
  for (const book of books) {
    if (stale(book, now, config.maxAgeMs) || bookSpreadBps(book).gt(settings.maxSpreadBps)) continue;
    const conversion = book.quote === "USDT" ? new Decimal(1) : usdtToman;
    if (!conversion) continue;
    let current: ReturnType<typeof measureOrderbookImbalance>;
    try {
      current = measureOrderbookImbalance(book, settings.levels, settings.levelWeightDecayPercent, conversion);
    } catch {
      continue;
    }
    if (Decimal.min(current.bidDepthToman, current.askDepthToman).lt(settings.minVisibleDepthToman)) continue;
    if (current.ratio.lt(settings.minRatio)) continue;
    const bidHeavy = current.bidHeavy;

    const sourceObservations = context.orderbookHistory?.get(book.symbol) ?? [{ observedAt: now, book }];
    const observations = sourceObservations
      .filter(item => item.observedAt <= now && now - item.observedAt <= settings.sampleWindowMs)
      .slice(-Math.max(settings.minConfirmations * 3, settings.minOutcomeSamples * 3, 20));
    if (!observations.some(item => item.observedAt === now)) observations.push({ observedAt: now, book });
    const samples = observations.flatMap(observation => {
      try {
        return [{
          observedAt: observation.observedAt,
          book: observation.book,
          measurement: measureOrderbookImbalance(observation.book, settings.levels, settings.levelWeightDecayPercent, conversion)
        }];
      } catch {
        return [];
      }
    }).sort((a, b) => a.observedAt - b.observedAt);
    const direction = bidHeavy ? 1 : -1;
    const realizedOutcomesBps: number[] = [];
    for (let index = 0; index < samples.length - 1; index += 1) {
      const source = samples[index];
      if (source.measurement.bidHeavy !== bidHeavy || source.measurement.ratio.lt(settings.minRatio)) continue;
      const sourceFlow = summarizeSnapshotOrderFlow(
        samples.slice(Math.max(0, index - Math.max(settings.minFlowSamples, 3)), index + 1),
        settings.levels,
        settings.levelWeightDecayPercent,
        conversion,
        Math.max(settings.minFlowSamples, 3)
      );
      const sourceDirectionalFlow = sourceFlow.normalizedFlow.mul(direction);
      const sourceRetention = bidHeavy
        ? sourceFlow.bidLiquidityRetentionPercent
        : sourceFlow.askLiquidityRetentionPercent;
      const sourceMicropriceAligned = source.measurement.micropriceBiasBps.mul(direction).gte(settings.minMicropriceBiasBps);
      if (sourceFlow.sampleCount < settings.minFlowSamples
        || sourceDirectionalFlow.lt(settings.minOrderFlowImbalance)
        || sourceRetention.lt(settings.minDominantLiquidityRetentionPercent)
        || !sourceMicropriceAligned
        || source.measurement.dominantTopLevelSharePercent.gt(settings.maxTopLevelSharePercent)) continue;
      const target = samples.slice(index + 1)
        .find(item => item.observedAt - source.observedAt >= settings.predictionHorizonMs);
      if (!target) continue;
      realizedOutcomesBps.push(target.measurement.midpoint.div(source.measurement.midpoint)
        .minus(1).mul(BPS).mul(direction).toNumber());
    }
    const outcomeHitRatePercent = realizedOutcomesBps.length
      ? realizedOutcomesBps.filter(value => value > 0).length / realizedOutcomesBps.length * 100
      : 0;
    const conservativeForecastBps = percentile(realizedOutcomesBps, 0.25);
    const qualifies = (sample: typeof samples[number]) => sample.measurement.bidHeavy === bidHeavy && sample.measurement.ratio.gte(settings.minRatio);
    let onsetIndex = samples.length - 1;
    while (onsetIndex > 0 && qualifies(samples[onsetIndex - 1])) onsetIndex -= 1;
    const confirmations = samples.slice(onsetIndex).filter(qualifies).length;
    const persistenceMs = samples.length ? Math.max(0, now - samples[onsetIndex].observedAt) : 0;
    const baseline = samples[Math.max(0, onsetIndex - 1)]?.measurement ?? current;
    const pressureDelta = current.normalized.minus(baseline.normalized).mul(direction);
    const favorableMidMoveBps = current.midpoint.div(baseline.midpoint).minus(1).mul(BPS).mul(direction);
    let cusum = new Decimal(0);
    for (const sample of samples.slice(Math.max(0, onsetIndex - 1))) {
      const directionalDeviation = sample.measurement.normalized.minus(baseline.normalized).mul(direction).minus("0.01");
      cusum = Decimal.max(0, cusum.plus(directionalDeviation));
    }
    const changePointScore = Decimal.max(pressureDelta, cusum);
    const flowStartIndex = Math.max(0, onsetIndex - 1);
    const orderFlow = summarizeSnapshotOrderFlow(
      samples.slice(flowStartIndex),
      settings.levels,
      settings.levelWeightDecayPercent,
      conversion,
      Math.max(settings.minFlowSamples, settings.minConfirmations, 3)
    );
    const directionalOrderFlow = orderFlow.normalizedFlow.mul(direction);
    const dominantLiquidityRetentionPercent = bidHeavy
      ? orderFlow.bidLiquidityRetentionPercent
      : orderFlow.askLiquidityRetentionPercent;
    const persistenceSafe = confirmations >= settings.minConfirmations
      && persistenceMs >= settings.minPersistenceMs
      && persistenceMs <= settings.maxPersistenceMs;
    const changePointSafe = changePointScore.gte(settings.minPressureDelta);
    const flowSamplesSafe = orderFlow.sampleCount >= settings.minFlowSamples;
    const orderFlowSafe = directionalOrderFlow.gte(settings.minOrderFlowImbalance);
    const liquidityRetentionSafe = dominantLiquidityRetentionPercent.gte(settings.minDominantLiquidityRetentionPercent);
    const concentrationSafe = current.dominantTopLevelSharePercent.lte(settings.maxTopLevelSharePercent);
    const micropriceSafe = bidHeavy
      ? current.micropriceBiasBps.gte(settings.minMicropriceBiasBps)
      : current.micropriceBiasBps.lte(-settings.minMicropriceBiasBps);
    const priceResponseSafe = favorableMidMoveBps.gte(-settings.maxAdverseMoveBps);
    // This Spot adapter is USDT-funded and cannot create a synthetic short.
    // Ask-heavy signals remain visible but are explicitly blocked.
    const longSpotExecutable = bidHeavy && book.quote === "USDT";
    const executionQuote = longSpotExecutable
      ? quote("BUY", book, settings.capitalToman, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent)
      : undefined;
    const immediateExitQuote = executionQuote
      ? quote("SELL", book, executionQuote.output, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent)
      : undefined;
    const priceImpactBps = executionQuote?.priceImpactBps;
    const exitPriceImpactBps = immediateExitQuote?.priceImpactBps;
    const executionDepthSafe = Boolean(
      executionQuote
      && immediateExitQuote
      && priceImpactBps?.lte(settings.maxPriceImpactBps)
      && exitPriceImpactBps?.lte(settings.maxPriceImpactBps)
    );
    const projectedRoundTripLossToman = immediateExitQuote
      ? Decimal.max(new Decimal(settings.capitalToman).minus(immediateExitQuote.output), 0)
      : new Decimal(settings.capitalToman);
    const projectedRoundTripCostBps = new Decimal(settings.capitalToman).gt(0)
      ? projectedRoundTripLossToman.div(settings.capitalToman).mul(BPS)
      : new Decimal(BPS);
    const roundTripSafetyHeadroomBps = Decimal.max(new Decimal(config.slippageBps).mul(2), 10);
    const projectedWorstRoundTripLossToman = projectedRoundTripLossToman.plus(
      new Decimal(settings.capitalToman).mul(roundTripSafetyHeadroomBps).div(BPS)
    );
    const roundTripRiskSafe = projectedRoundTripCostBps.plus(roundTripSafetyHeadroomBps).lt(settings.stopLossBps)
      && projectedWorstRoundTripLossToman.lt(settings.maxLossToman);
    const predictedNetBps = new Decimal(conservativeForecastBps)
      .minus(projectedRoundTripCostBps)
      .minus(settings.forecastSafetyBps);
    const outcomeCalibrated = settings.minOutcomeSamples === 0 || (
      realizedOutcomesBps.length >= settings.minOutcomeSamples
      && outcomeHitRatePercent >= settings.minOutcomeHitRatePercent
      && predictedNetBps.gte(settings.minPredictedNetBps)
    );
    const actionable = longSpotExecutable
      && persistenceSafe
      && changePointSafe
      && flowSamplesSafe
      && orderFlowSafe
      && liquidityRetentionSafe
      && concentrationSafe
      && micropriceSafe
      && priceResponseSafe
      && executionDepthSafe
      && roundTripRiskSafe
      && outcomeCalibrated;
    const legacyReasons = actionable
      ? [
          `فشار خرید در ${confirmations} نمونه و ${persistenceMs} میلی‌ثانیه تأیید شده است`,
          "وزن سطوح نزدیک، Microprice و اثر قیمت اجرای واقعی هم‌جهت هستند",
          `کالیبراسیون ${realizedOutcomesBps.length} خروجی تاریخی، Hit Rate ${outcomeHitRatePercent.toFixed(1)}٪ و بازده خالص ${predictedNetBps.toFixed(2)} BPS را تأیید کرده است`,
          "نقدینگی نمایشی می‌تواند لغو یا پنهان شود؛ سود تضمین‌شده نیست و سفارش فقط پس از بازاعتبارسنجی لحظه‌ای ارسال می‌شود."
        ]
      : [
          !longSpotExecutable
            ? bidHeavy ? "این بازار مبتنی بر USDT نیست و اجرای Long Spot ندارد" : "فشار سمت Ask است و موتور Spot امکان Short ندارد"
            : !persistenceSafe
              ? `سیگنال هنوز تداوم کافی ندارد: ${confirmations}/${settings.minConfirmations} نمونه، ${persistenceMs}ms`
              : !changePointSafe
                ? "افزایش فشار نسبت به خط پایه برای Change Point کافی نیست"
                : !concentrationSafe
                  ? "حجم غالب بیش از حد روی Level اول متمرکز است؛ احتمال Wall یا Spoofing بالاست"
                  : !micropriceSafe
                    ? "Microprice حرکت احتمالی را در جهت سیگنال تأیید نمی‌کند"
                    : !priceResponseSafe
                      ? "قیمت میانی برخلاف فشار اردربوک حرکت کرده؛ احتمال Absorption وجود دارد"
                      : !executionDepthSafe
                        ? "عمق قابل اجرا یا اثر قیمت برای سرمایه تنظیم‌شده مناسب نیست"
                        : !roundTripRiskSafe
                          ? `هزینه رفت‌وبرگشت ${projectedRoundTripCostBps.toFixed(2)} BPS با Stop Loss ${settings.stopLossBps} BPS حاشیه امن ندارد`
                          : `کالیبراسیون Shadow کافی نیست: ${realizedOutcomesBps.length}/${settings.minOutcomeSamples} نمونه، Hit Rate ${outcomeHitRatePercent.toFixed(1)}٪، بازده خالص محافظه‌کارانه ${predictedNetBps.toFixed(2)} BPS`,
          "تنها Snapshotهای جدید صرافی شمرده می‌شوند و اجرای واقعی تا اثبات بازده خارج از نمونه مسدود است."
        ];
    const reasons = actionable
      ? [
          `Buy pressure persisted for ${confirmations} independent snapshots over ${persistenceMs} ms.`,
          `Forward calibration passed with ${realizedOutcomesBps.length} outcomes, ${outcomeHitRatePercent.toFixed(1)}% hit rate and ${predictedNetBps.toFixed(2)} BPS conservative net return. Profit is not guaranteed.`
        ]
      : [
          !longSpotExecutable
            ? "Only USDT-quoted, bid-heavy Long Spot signals can execute."
            : !persistenceSafe
              ? `Persistence is incomplete: ${confirmations}/${settings.minConfirmations} snapshots over ${persistenceMs} ms.`
              : !changePointSafe
                ? "The orderbook pressure change point is below the configured threshold."
                : !flowSamplesSafe
                  ? `Order-flow history is incomplete: ${orderFlow.sampleCount}/${settings.minFlowSamples} snapshot transitions.`
                  : !orderFlowSafe
                    ? favorableMidMoveBps.lt(0)
                      ? `Snapshot MLOFI ${directionalOrderFlow.toFixed(4)} and midpoint both moved against the signal; possible Absorption is blocking entry.`
                      : `Snapshot MLOFI ${directionalOrderFlow.toFixed(4)} does not confirm the pressure direction.`
                    : !liquidityRetentionSafe
                      ? `Dominant-side liquidity retention ${dominantLiquidityRetentionPercent.toFixed(1)}% is too low; the wall may be fleeting.`
                : !concentrationSafe
                  ? "Top-level concentration failed the Spoofing/wall guard."
                  : !micropriceSafe
                    ? "Microprice does not confirm the signal direction."
                    : !priceResponseSafe
                      ? "Midpoint moved against the pressure signal; possible Absorption is blocking entry."
                      : !executionDepthSafe
                        ? "Executable depth or price impact is outside the configured limits."
                        : !roundTripRiskSafe
                          ? `Projected round-trip cost ${projectedRoundTripCostBps.toFixed(2)} BPS has no safe headroom below Stop Loss.`
                          : !outcomeCalibrated
                            ? `Forward calibration is incomplete: ${realizedOutcomesBps.length}/${settings.minOutcomeSamples} outcomes, ${outcomeHitRatePercent.toFixed(1)}% hit rate, ${predictedNetBps.toFixed(2)} BPS conservative net return.`
                            : "One or more Live entry gates did not pass."
        ];
    void legacyReasons;
    const confidence = Decimal.min(90,
      Decimal.min(25, current.ratio.div(settings.minRatio).mul(18))
        .plus(Decimal.min(20, new Decimal(confirmations).div(Math.max(1, settings.minConfirmations)).mul(18)))
        .plus(Decimal.min(20, changePointScore.div(settings.minPressureDelta || 1).mul(15)))
        .plus(flowSamplesSafe && orderFlowSafe ? 10 : 0)
        .plus(liquidityRetentionSafe ? 8 : 0)
        .plus(concentrationSafe ? 12 : 0)
        .plus(micropriceSafe ? 10 : 0)
        .plus(executionDepthSafe ? 8 : 0)
    );
    signals.push({
      id: `imbalance:${book.symbol}`,
      kind: "orderbook-imbalance",
      title: `${book.symbol} Weighted Imbalance`,
      symbols: [book.symbol],
      action: bidHeavy ? "Momentum Long after confirmation" : "Monitor sell pressure (no Spot short)",
      status: actionable ? "actionable" : longSpotExecutable ? "watch" : "blocked",
      paperOnly: true,
      expectedEdgeBps: outcomeCalibrated ? predictedNetBps : new Decimal(0),
      estimatedNetProfitToman: outcomeCalibrated
        ? Decimal.max(0, new Decimal(settings.capitalToman).mul(predictedNetBps).div(BPS))
        : new Decimal(0),
      confidence,
      reasons,
      metrics: {
        ratio: current.ratio.toNumber(),
        normalizedImbalance: current.normalized.toNumber(),
        bidDepthToman: current.bidDepthToman.toNumber(),
        askDepthToman: current.askDepthToman.toNumber(),
        weightedBidDepthToman: current.weightedBidDepthToman.toNumber(),
        weightedAskDepthToman: current.weightedAskDepthToman.toNumber(),
        levels: settings.levels,
        levelWeightDecayPercent: settings.levelWeightDecayPercent,
        spreadBps: bookSpreadBps(book).toNumber(),
        priceImpactBps: priceImpactBps?.toNumber() ?? -1,
        exitPriceImpactBps: exitPriceImpactBps?.toNumber() ?? -1,
        projectedRoundTripCostBps: projectedRoundTripCostBps.toNumber(),
        projectedRoundTripLossToman: projectedRoundTripLossToman.toNumber(),
        roundTripRiskPassed: roundTripRiskSafe,
        predictionHorizonMs: settings.predictionHorizonMs,
        outcomeSampleCount: realizedOutcomesBps.length,
        outcomeHitRatePercent,
        conservativeForecastBps,
        predictedNetBps: predictedNetBps.toNumber(),
        outcomeCalibrated,
        micropriceBiasBps: current.micropriceBiasBps.toNumber(),
        dominantTopLevelSharePercent: current.dominantTopLevelSharePercent.toNumber(),
        confirmations,
        persistenceMs,
        pressureDelta: pressureDelta.toNumber(),
        cusumScore: cusum.toNumber(),
        changePointScore: changePointScore.toNumber(),
        orderFlowSampleCount: orderFlow.sampleCount,
        normalizedOrderFlow: orderFlow.normalizedFlow.toNumber(),
        directionalOrderFlow: directionalOrderFlow.toNumber(),
        bidLiquidityRetentionPercent: orderFlow.bidLiquidityRetentionPercent.toNumber(),
        askLiquidityRetentionPercent: orderFlow.askLiquidityRetentionPercent.toNumber(),
        dominantLiquidityRetentionPercent: dominantLiquidityRetentionPercent.toNumber(),
        orderFlowConfirmed: flowSamplesSafe && orderFlowSafe,
        liquidityRetentionPassed: liquidityRetentionSafe,
        favorableMidMoveBps: favorableMidMoveBps.toNumber(),
        temporalConfirmed: persistenceSafe && changePointSafe,
        spoofingGuardPassed: concentrationSafe,
        priceConfirmationPassed: micropriceSafe && priceResponseSafe,
        executionDepthSafe,
        direction: bidHeavy ? "LONG" : "SHORT",
        spotExecutable: longSpotExecutable,
        quoteAsset: book.quote,
        exitRatio: settings.exitRatio,
        capitalToman: settings.capitalToman
      },
      scannedAt: now
    });
  }
  return signals.sort((a, b) => b.confidence.comparedTo(a.confidence)).slice(0, 20);
}

function quote(side: "BUY" | "SELL", book: OrderBook, input: Decimal.Value, fee: number, slippage: number, depth: number) {
  return quoteEdge({ id: `${book.symbol}:${side}`, from: side === "BUY" ? book.quote : book.base, to: side === "BUY" ? book.base : book.quote, side, book }, input, fee, slippage, depth);
}

function mid(book: OrderBook) {
  const bid = book.bids[0]?.price, ask = book.asks[0]?.price;
  return bid && ask ? bid.plus(ask).div(2) : undefined;
}

function stale(book: OrderBook, now: number, maxAge: number) { return !book.lastUpdate || now - book.lastUpdate > maxAge; }
function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
