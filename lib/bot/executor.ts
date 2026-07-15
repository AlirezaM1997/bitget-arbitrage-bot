import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import type { BotSettings } from "@/lib/bot-settings";
import { bitgetClientSettings } from "@/lib/bitget-runtime-settings";
import { BitgetClient } from "@/lib/exchanges/bitget";
import type { MarketOptions, BitgetOrder, OrderBook, Side } from "@/lib/exchanges/types";
import { findTriangularOpportunities, quoteEdge } from "./engine";
import type { ConversionEdge, Opportunity } from "./types";

export type ExecutionLeg = {
  stage?: "cycle" | "recovery";
  symbol: string;
  side: string;
  orderId: string;
  clientOrderId?: string;
  status: string;
  input: string;
  expectedOutput: string;
  output: string;
  averagePrice: string;
  fee: string;
  feeAsset?: string;
  feeBreakdown?: Array<{ asset: string; amount: string }>;
  slippageBuffer: string;
  levelsUsed: number;
  totalLevels: number;
  depthConsumedPercent: string;
  priceImpactBps: string;
  spreadBps: string;
  inputAsset?: string;
  outputAsset?: string;
  matchedAmount?: string;
  unmatchedAmount?: string;
};

export type LiveExecutionClient = Pick<
  BitgetClient,
  "getAllOrderBooks" | "getMarketOptions" | "placeMarketOrder" | "getOrderStatus" | "cancelOrder"
> & Partial<Pick<BitgetClient, "getOrderStatusByClientOrderId">>;

export type RecoveryPosition = { asset: string; amount: Decimal };
export type LiveInventory = Record<string, Decimal>;
export type RecoveryLegEvent = {
  phase: "submitted" | "finalized";
  reason: string;
  attempt: number;
  position: RecoveryPosition;
  leg: ExecutionLeg;
};
export type LiveRecoveryResult = {
  reason: string;
  actualInputToman: Decimal;
  preRecoveryToman: Decimal;
  startedInventory: RecoveryPosition[];
  residualInventory: RecoveryPosition[];
  recoveredToman: Decimal;
  residualValueToman: Decimal;
  externalFeeValueToman: Decimal;
  economicRecoveredToman: Decimal;
  legs: ExecutionLeg[];
};
export type RecoverIntermediateInventoryInput = {
  reason: string;
  actualInputToman: Decimal.Value;
  preRecoveryToman?: Decimal.Value;
  inventory: RecoveryPosition[];
  settings: BotSettings;
  options: MarketOptions;
  client: LiveExecutionClient;
  hooks?: LiveExecutionHooks;
  logs?: ExecutionLeg[];
  now?: () => number;
  maxAttemptsPerAsset?: number;
};

export type LiveOrderIntentContext = {
  stage: "cycle" | "recovery";
  legIndex?: number;
  attempt?: number;
  asset?: string;
  symbol: string;
  side: Side;
  clientOrderId: string;
  requestedInput: Decimal;
  amountBase: Decimal;
  worstPrice: Decimal;
  protectedPrice: Decimal;
};

export type LiveExecutionHooks = {
  onPrepared?: (opportunity: Opportunity) => Promise<unknown> | unknown;
  /** Last gate before a normal cycle order. A thrown error prevents that order from being submitted. */
  onBeforeOrder?: (plannedLegIndex: number, context: LiveOrderIntentContext) => Promise<unknown> | unknown;
  /** Separate unwind gate: normal emergency-stop logic must not prevent exposure reduction. */
  onBeforeRecoveryOrder?: (event: {
    asset: string;
    amount: Decimal;
    attempt: number;
    symbol: string;
    side: Side;
    clientOrderId: string;
    requestedInput: Decimal;
    amountBase: Decimal;
    worstPrice: Decimal;
    protectedPrice: Decimal;
  }) => Promise<unknown> | unknown;
  /** Persist this intent before the network call, keyed by clientOrderId for crash-safe reconciliation. */
  onOrderIntent?: (event: {
    stage: "cycle" | "recovery";
    clientOrderId: string;
    symbol: string;
    side: Side;
    amountBase: Decimal;
    expectedPrice: Decimal;
  }) => Promise<unknown> | unknown;
  onLeg?: (leg: ExecutionLeg, completedLegs: ExecutionLeg[]) => Promise<unknown> | unknown;
  onRecoveryStarted?: (event: { reason: string; inventory: RecoveryPosition[] }) => Promise<unknown> | unknown;
  onRecoveryLeg?: (event: RecoveryLegEvent) => Promise<unknown> | unknown;
  onRecoveryCompleted?: (result: LiveRecoveryResult) => Promise<unknown> | unknown;
  onManualInterventionRequired?: (event: { reason: string; inventory: RecoveryPosition[]; error: Error }) => Promise<unknown> | unknown;
};
export type LiveMarketSnapshot = { books: OrderBook[]; options: MarketOptions };

export class LiveExecutionRecoveredError extends Error {
  readonly code = "CYCLE_FAILED_RECOVERED";
  readonly manualInterventionRequired = false;

  constructor(message: string, public readonly recovery: LiveRecoveryResult, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiveExecutionRecoveredError";
  }
}

export class LiveManualInterventionError extends Error {
  readonly code = "MANUAL_INTERVENTION_REQUIRED";
  readonly manualInterventionRequired = true;

  constructor(
    message: string,
    public readonly inventory: RecoveryPosition[],
    public readonly recoveryLegs: ExecutionLeg[] = [],
    options?: ErrorOptions
  ) {
    super(`MANUAL INTERVENTION REQUIRED: ${message}`, options);
    this.name = "LiveManualInterventionError";
  }
}

export class LiveOrderStateUnknownError extends Error {
  readonly code = "ORDER_STATE_UNKNOWN";

  constructor(public readonly orderId: string, message?: string, options?: ErrorOptions) {
    super(message ?? `Order ${orderId} did not reach a confirmed terminal state`, options);
    this.name = "LiveOrderStateUnknownError";
  }
}

export async function executeLive(
  opportunity: Opportunity,
  settings: BotSettings,
  client: LiveExecutionClient = new BitgetClient(bitgetClientSettings(settings)),
  hooks: LiveExecutionHooks = {},
  snapshot?: LiveMarketSnapshot
) {
  // Dependency-injected mocks do not need account credentials; the production adapter always does.
  if (client instanceof BitgetClient) assertLiveCredentials();
  const [initialBooks, options] = snapshot
    ? [snapshot.books, snapshot.options]
    : await Promise.all([client.getAllOrderBooks(), client.getMarketOptions()]);
  let activeOpportunity = repriceLiveOpportunity(opportunity, settings, initialBooks, options);
  if (!activeOpportunity) throw new Error("مسیر در بازبینی Live دیگر تمام شروط سود و نقدشوندگی را ندارد؛ هیچ سفارشی ارسال نشد");
  assertLiveSafetyMargin(activeOpportunity, settings, "بازبینی اول");

  // یک snapshot سودده ممکن است فقط چند میلی‌ثانیه دوام داشته باشد؛ پیش از سفارش، بازار با اردربوک تازه دوباره قیمت‌گذاری می‌شود.
  const freshBooks = await client.getAllOrderBooks();
  activeOpportunity = repriceLiveOpportunity(opportunity, settings, freshBooks, options);
  if (!activeOpportunity) throw new Error("مسیر در بازاعتبارسنجی نهایی Live ناپدید شد؛ هیچ سفارشی ارسال نشد");
  assertLiveSafetyMargin(activeOpportunity, settings, "بازاعتبارسنجی نهایی");
  await hooks.onPrepared?.(activeOpportunity);
  let current = activeOpportunity.inputToman;
  let actualInputToman: Decimal | undefined;
  let residualInventory: RecoveryPosition[] = [];
  let residualValueToman = new Decimal(0);
  const logs: ExecutionLeg[] = [];
  const persistLegs = async (leg: ExecutionLeg) => {
    try {
      await hooks.onLeg?.(leg, [...logs]);
    } catch {
      // خطای ثبت لاگ پس از ارسال سفارش نباید چرخه را در دارایی میانی متوقف کند.
    }
  };

  // همان مسیر روی اردربوک تازه از سقف سرمایه واقعی دوباره اندازه‌گذاری شده است.
  const freshQuotes = activeOpportunity.legs;
  for (const quote of freshQuotes) assertLiquiditySafe(quote, settings, "before execution");
  current = activeOpportunity.outputToman;
  const expectedProfit = activeOpportunity.netProfitToman;
  const expectedBps = activeOpportunity.profitBps;
  if (expectedProfit.lt(settings.minNetProfitToman) || expectedBps.lt(settings.minProfitBps)) {
    throw new Error("Opportunity disappeared during live revalidation; no order was sent");
  }

  current = activeOpportunity.inputToman;
  let inventory: LiveInventory = { USDT: activeOpportunity.inputToman };
  let confirmedFill = false;
  try {
  for (let i = 0; i < freshQuotes.length; i += 1) {
    const planned = freshQuotes[i];
    // پس از هر fill، کل خروجی نهایی مسیر با موجودی واقعی و اردربوک تازه دوباره محاسبه می‌شود.
    const books = i === 0 ? freshBooks : await client.getAllOrderBooks();
    assertExecutionSnapshot(books, freshQuotes.slice(i), settings, Date.now());
    const book = books.find((b: OrderBook) => b.symbol === planned.edge.book.symbol);
    if (!book) throw new Error(`Market disappeared while executing: ${planned.edge.book.symbol}`);
    const edge = { ...planned.edge, book };
    const liveQuote = quoteEdge(edge, current, feeForMarket(edge.book, options, settings), settings.slippageBufferBps, settings.orderbookDepthUsagePercent);
    if (!liveQuote) throw new Error(`Insufficient live depth on ${book.symbol}; intermediate asset may require manual recovery`);
    assertLiquiditySafe(liveQuote, settings, i === 0 ? "before first order" : "during execution");
    const projectedFinal = projectRemainingOutput(freshQuotes, i, current, inventory, books, options, settings);
    if (!projectedFinal) throw new Error(`مسیر باقی‌مانده قبل از سفارش ${i + 1} عمق کافی ندارد؛ اجرای خودکار متوقف شد`);
    const profitBase = actualInputToman ?? activeOpportunity.inputToman;
    assertProjectedFinal(projectedFinal, profitBase, settings, i);

    // در BUY کارمزد از رمزارز دریافتی کسر می‌شود؛ grossOutput حجم صحیح سفارش است.
    // حجم BUY فقط از مرز واقعی قیمت محافظت‌شده و precision رسمی مشتق می‌شود؛
    // Live profit buffer هیچ‌وقت برای کوچک‌کردن سفارش یا جاگذاشتن موجودی میانی استفاده نمی‌شود.
    const amountStep = officialStep(options.amountSteps, book.symbol, "amount");
    const priceStep = officialStep(options.priceSteps, book.symbol, "price");
    const protection = protectedMarketOrder(liveQuote, priceStep, settings);
    const amountBase = safeOrderAmountBase(edge.side, current, liveQuote, amountStep, protection.maximumBuyFillPrice);
    if (amountBase.lte(0)) throw new Error(`Rounded amount is zero for ${book.symbol}`);
    assertMinimumOrder(book, edge.side, amountBase, liveQuote, options, books);

    const clientOrderId = uniqueClientOrderId("tri", i);
    let order: BitgetOrder;
    const intentContext: LiveOrderIntentContext = {
      stage: "cycle", legIndex: i, symbol: book.symbol, side: edge.side, clientOrderId,
      requestedInput: new Decimal(current), amountBase,
      worstPrice: new Decimal(liveQuote.worstPrice), protectedPrice: protection.expectedPrice
    };
    await hooks.onBeforeOrder?.(i, intentContext);
    await hooks.onOrderIntent?.({
      stage: "cycle", clientOrderId, symbol: book.symbol, side: edge.side,
      amountBase, expectedPrice: protection.expectedPrice
    });
    order = await submitOrReconcile(client, {
      side: edge.side, base: book.base, quote: book.quote, amountBase,
      expectedPrice: protection.expectedPrice,
      clientOrderId
    }, `submission:${book.symbol}:${i}`);
    const executionLeg: ExecutionLeg = {
      stage: "cycle",
      symbol: book.symbol,
      side: edge.side,
      orderId: order.id,
      clientOrderId,
      status: order.status,
      input: liveQuote.input.toString(),
      expectedOutput: liveQuote.output.toString(),
      output: "0",
      averagePrice: liveQuote.averagePrice.toString(),
      fee: liveQuote.fee.toString(),
      slippageBuffer: liveQuote.slippageBuffer.toString(),
      levelsUsed: liveQuote.levelsUsed,
      totalLevels: liveQuote.totalLevels,
      depthConsumedPercent: liveQuote.depthConsumedPercent.toString(),
      priceImpactBps: liveQuote.priceImpactBps.toString(),
      spreadBps: liveQuote.spreadBps.toString(),
      inputAsset: edge.from,
      outputAsset: edge.to,
      matchedAmount: "0",
      unmatchedAmount: amountBase.toString()
    };
    logs.push(executionLeg);
    await persistLegs(executionLeg);

    const final = await waitForFinalOrder(client, order, settings.orderTimeoutMs);
    executionLeg.status = final.status;
    executionLeg.matchedAmount = final.matchedAmount.toString();
    executionLeg.unmatchedAmount = final.unmatchedAmount.toString();
    executionLeg.input = realizedOrderInput(edge.side, book, final).toString();
    executionLeg.output = realizedOrderOutput(edge.side, book, final).toString();
    executionLeg.averagePrice = normalizeOrderPrice(final.averagePrice).toString();
    executionLeg.fee = final.fee.toString();
    executionLeg.feeAsset = normalizedFeeAsset(final, edge.to);
    executionLeg.feeBreakdown = serializedFeeBreakdown(final, edge.to);
    if (final.matchedAmount.gt(0)) {
      confirmedFill = true;
      inventory = applyConfirmedOrderToInventory(inventory, book, edge.side, final);
      if (i === 0) actualInputToman = realizedInitialUsdtInput(edge.from, edge.side, book, final);
    }
    if (final.matchedAmount.lte(0) || final.unmatchedAmount.gt(0)) {
      await persistLegs(executionLeg);
      throw new Error(`Order ${final.id} was not filled completely (${final.status}); cycle stopped for recovery`);
    }
    await persistLegs(executionLeg);
    current = realizedOrderOutput(edge.side, book, final);
    if (current.lte(0)) throw new Error(`Cannot determine output of order ${final.id}`);
    executionLeg.output = current.toString();
    await persistLegs(executionLeg);
  }
  residualInventory = intermediateInventory(inventory);
  if (residualInventory.length) {
    const valuationBooks = await client.getAllOrderBooks();
    const tradable: RecoveryPosition[] = [];
    const dust: RecoveryPosition[] = [];
    for (const residual of residualInventory) {
      const liquidation = prepareRecoveryOrder(
        residual.asset, residual.amount, valuationBooks, options, settings, Date.now()
      );
      (liquidation ? tradable : dust).push(residual);
    }
    if (tradable.length) {
      const settlement = await recoverIntermediateInventory({
        reason: "post-cycle residual settlement",
        actualInputToman: actualInputToman ?? activeOpportunity.inputToman,
        preRecoveryToman: current,
        inventory: tradable,
        settings, options, client, hooks, logs
      });
      current = settlement.recoveredToman;
      residualInventory = mergeRecoveryPositions([...dust, ...settlement.residualInventory]);
    } else {
      residualInventory = dust;
    }
    inventory = { USDT: current };
    for (const residual of residualInventory) inventory[residual.asset] = residual.amount;
    residualValueToman = valueResidualDust(residualInventory, valuationBooks, options, settings, Date.now());
  }
  } catch (error) {
    const exposed = intermediateInventory(inventory);
    if (error instanceof LiveManualInterventionError) throw error;
    if (error instanceof LiveOrderStateUnknownError) {
      const manual = new LiveManualInterventionError(
        `${error.message}. Inspect the order and wallet before restarting the bot.`,
        exposed,
        logs.filter(leg => leg.stage === "recovery"),
        { cause: error }
      );
      await safeHook(() => hooks.onManualInterventionRequired?.({ reason: manual.message, inventory: exposed, error: manual }));
      throw manual;
    }
    if (!confirmedFill || !exposed.length) throw error;

    let recovery: LiveRecoveryResult;
    try {
      const recoveryInputToman = actualInputToman ?? activeOpportunity.inputToman;
      const unspentInitialToman = Decimal.max(activeOpportunity.inputToman.minus(recoveryInputToman), 0);
      const preRecoveryToman = Decimal.max((inventory.USDT ?? new Decimal(0)).minus(unspentInitialToman), 0);
      recovery = await recoverIntermediateInventory({
        reason: errorMessage(error),
        actualInputToman: recoveryInputToman,
        preRecoveryToman,
        inventory: exposed, settings, options, client, hooks, logs
      });
    } catch (recoveryError) {
      if (recoveryError instanceof LiveManualInterventionError) throw recoveryError;
      const manual = new LiveManualInterventionError(
        `Automatic recovery failed: ${errorMessage(recoveryError)}`,
        exposed,
        logs.filter(leg => leg.stage === "recovery"),
        { cause: recoveryError }
      );
      await safeHook(() => hooks.onManualInterventionRequired?.({ reason: manual.message, inventory: exposed, error: manual }));
      throw manual;
    }
    throw new LiveExecutionRecoveredError(
      recovery.residualInventory.length
        ? `Triangular cycle failed; all tradable inventory was converted to USDT and ${recovery.residualInventory.length} marked dust position remains. Original failure: ${errorMessage(error)}`
        : `Triangular cycle failed, but all tracked intermediate inventory was automatically converted to USDT. Original failure: ${errorMessage(error)}`,
      recovery,
      { cause: error }
    );
  }
  const executedInputToman = actualInputToman ?? activeOpportunity.inputToman;
  let externalFeeValueToman: Decimal;
  try {
    externalFeeValueToman = await valueExternalFeesInUsdt(logs, client, options, settings);
  } catch (error) {
    const manual = new LiveManualInterventionError(
      `Bitget cycle settled, but external fee valuation failed and economic PnL was withheld: ${errorMessage(error)}`,
      [],
      logs.filter(leg => leg.stage === "recovery"),
      { cause: error }
    );
    await safeHook(() => hooks.onManualInterventionRequired?.({ reason: manual.message, inventory: [], error: manual }));
    throw manual;
  }
  const realizedAfterExternalFees = Decimal.max(current.minus(externalFeeValueToman), 0);
  const economicOutputToman = realizedAfterExternalFees.plus(residualValueToman);
  return {
    requestedInputToman: activeOpportunity.requestedInputToman,
    inputToman: executedInputToman,
    outputToman: economicOutputToman,
    profitToman: economicOutputToman.minus(executedInputToman),
    realizedOutputToman: realizedAfterExternalFees,
    realizedProfitToman: realizedAfterExternalFees.minus(executedInputToman),
    residualInventory,
    residualValueToman,
    externalFeeValueToman,
    fullySettled: residualInventory.length === 0,
    legs: logs
  };
}

/**
 * Applies only a confirmed exchange fill to an execution-local inventory ledger.
 * This never reads wallet balances, so pre-existing account inventory cannot be sold accidentally.
 */
export function applyConfirmedOrderToInventory(
  inventory: LiveInventory,
  book: Pick<OrderBook, "base" | "quote">,
  side: Side,
  order: BitgetOrder
): LiveInventory {
  const next = Object.fromEntries(
    Object.entries(inventory).map(([asset, amount]) => [asset.toUpperCase(), new Decimal(amount)])
  ) as LiveInventory;
  if (order.matchedAmount.lte(0)) return next;
  const base = book.base.toUpperCase();
  const quote = book.quote.toUpperCase();
  if (side === "BUY") {
    next[quote] = Decimal.max((next[quote] ?? new Decimal(0)).minus(order.totalPrice), 0);
    next[base] = (next[base] ?? new Decimal(0)).plus(order.matchedAmount);
  } else {
    next[base] = Decimal.max((next[base] ?? new Decimal(0)).minus(order.matchedAmount), 0);
    next[quote] = (next[quote] ?? new Decimal(0)).plus(order.totalPrice);
  }

  const defaultFeeAsset = side === "BUY" ? base : quote;
  for (const fee of normalizedOrderFees(order, defaultFeeAsset)) {
    if (fee.asset === base || fee.asset === quote) {
      next[fee.asset] = Decimal.max((next[fee.asset] ?? new Decimal(0)).minus(fee.amount), 0);
    }
  }
  return next;
}

export function intermediateInventory(inventory: LiveInventory): RecoveryPosition[] {
  return Object.entries(inventory)
    .map(([asset, amount]) => ({ asset: asset.toUpperCase(), amount: new Decimal(amount) }))
    .filter(position => position.asset !== "USDT" && position.amount.gt(0))
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

/**
 * Converts execution-local intermediate balances to USDT. Every attempt uses a new orderbook snapshot,
 * a protected SELL price, configured depth reservation and the same spread/impact limits as Live entry.
 */
export async function recoverIntermediateInventory(input: RecoverIntermediateInventoryInput): Promise<LiveRecoveryResult> {
  const hooks = input.hooks ?? {};
  const logs = input.logs ?? [];
  const now = input.now ?? Date.now;
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(input.maxAttemptsPerAsset ?? 2)));
  const startedInventory = mergeRecoveryPositions(input.inventory);
  const remaining = new Map(startedInventory.map(position => [position.asset, position.amount]));
  const recoveryLegs: ExecutionLeg[] = [];
  const preRecoveryToman = new Decimal(input.preRecoveryToman ?? 0);
  let recoveredToman = preRecoveryToman;
  await safeHook(() => hooks.onRecoveryStarted?.({ reason: input.reason, inventory: clonePositions(startedInventory) }));

  try {
    for (const position of startedInventory) {
      let amount = position.amount;
      for (let attempt = 1; attempt <= maxAttempts && amount.gt(0); attempt += 1) {
        const books = await input.client.getAllOrderBooks();
        const prepared = prepareRecoveryOrder(
          position.asset, amount, books, input.options, input.settings, now()
        );
        if (!prepared) break;
        const { book, edge, quote, amountBase, protection } = prepared;

        const clientOrderId = uniqueClientOrderId("trr", attempt);
        let order: BitgetOrder;
        await hooks.onBeforeRecoveryOrder?.({
          asset: position.asset, amount: new Decimal(amount), attempt,
          symbol: book.symbol, side: edge.side, clientOrderId,
          requestedInput: new Decimal(amount), amountBase,
          worstPrice: new Decimal(quote.worstPrice), protectedPrice: protection.expectedPrice
        });
        await hooks.onOrderIntent?.({
          stage: "recovery", clientOrderId, symbol: book.symbol, side: edge.side,
          amountBase, expectedPrice: protection.expectedPrice
        });
        order = await submitOrReconcile(input.client, {
          side: edge.side, base: book.base, quote: book.quote, amountBase,
          expectedPrice: protection.expectedPrice,
          clientOrderId
        }, `recovery-submission:${book.symbol}:${attempt}`);

        const leg: ExecutionLeg = {
          stage: "recovery",
          symbol: book.symbol,
          side: edge.side,
          orderId: order.id,
          clientOrderId,
          status: order.status,
          input: amountBase.toString(),
          expectedOutput: quote.output.toString(),
          output: "0",
          averagePrice: quote.averagePrice.toString(),
          fee: quote.fee.toString(),
          slippageBuffer: quote.slippageBuffer.toString(),
          levelsUsed: quote.levelsUsed,
          totalLevels: quote.totalLevels,
          depthConsumedPercent: quote.depthConsumedPercent.toString(),
          priceImpactBps: quote.priceImpactBps.toString(),
          spreadBps: quote.spreadBps.toString(),
          inputAsset: position.asset,
          outputAsset: "USDT",
          matchedAmount: "0",
          unmatchedAmount: amountBase.toString()
        };
        logs.push(leg);
        recoveryLegs.push(leg);
        await safeHook(() => hooks.onLeg?.(leg, [...logs]));
        await safeHook(() => hooks.onRecoveryLeg?.({
          phase: "submitted", reason: input.reason, attempt,
          position: { asset: position.asset, amount }, leg
        }));

        const final = await waitForFinalOrder(input.client, order, input.settings.orderTimeoutMs);
        leg.status = final.status;
        leg.matchedAmount = final.matchedAmount.toString();
        leg.unmatchedAmount = final.unmatchedAmount.toString();
        leg.input = realizedOrderInput(edge.side, book, final).toString();
        leg.output = realizedOrderOutput(edge.side, book, final).toString();
        leg.averagePrice = normalizeOrderPrice(final.averagePrice).toString();
        leg.fee = final.fee.toString();
        leg.feeAsset = normalizedFeeAsset(final, "USDT");
        leg.feeBreakdown = serializedFeeBreakdown(final, "USDT");
        await safeHook(() => hooks.onLeg?.(leg, [...logs]));
        await safeHook(() => hooks.onRecoveryLeg?.({
          phase: "finalized", reason: input.reason, attempt,
          position: { asset: position.asset, amount }, leg
        }));

        if (final.matchedAmount.lte(0)) throw new Error(`Recovery order ${final.id} had no confirmed fill`);
        recoveredToman = recoveredToman.plus(realizedOrderOutput(edge.side, book, final));
        amount = Decimal.max(amount.minus(realizedOrderInput(edge.side, book, final)), 0);
        remaining.set(position.asset, amount);
        const fullyFilled = final.unmatchedAmount.lte(0) && final.matchedAmount.gte(amountBase);
        if (!fullyFilled && attempt === maxAttempts) {
          throw new Error(`Recovery order ${final.id} remained partially filled after ${maxAttempts} safe attempts`);
        }
      }

      if (amount.gt(0)) {
        const books = await input.client.getAllOrderBooks();
        const stillTradable = prepareRecoveryOrder(
          position.asset, amount, books, input.options, input.settings, now()
        );
        if (stillTradable) throw new Error(`Automatic recovery left tradable ${amount.toString()} ${position.asset}`);
      }
      remaining.set(position.asset, amount);
    }

    const residualInventory = positionsFromMap(remaining);
    const residualValueToman = residualInventory.length
      ? valueResidualDust(residualInventory, await input.client.getAllOrderBooks(), input.options, input.settings, now())
      : new Decimal(0);
    const externalFeeValueToman = await valueExternalFeesInUsdt(
      logs, input.client, input.options, input.settings
    );
    const result: LiveRecoveryResult = {
      reason: input.reason,
      actualInputToman: new Decimal(input.actualInputToman),
      preRecoveryToman,
      startedInventory: clonePositions(startedInventory),
      residualInventory,
      recoveredToman,
      residualValueToman,
      externalFeeValueToman,
      economicRecoveredToman: Decimal.max(
        recoveredToman.plus(residualValueToman).minus(externalFeeValueToman),
        0
      ),
      legs: recoveryLegs
    };
    await safeHook(() => hooks.onRecoveryCompleted?.(result));
    return result;
  } catch (error) {
    const unresolved = positionsFromMap(remaining);
    const manual = error instanceof LiveManualInterventionError
      ? error
      : new LiveManualInterventionError(
        `Automatic USDT recovery failed: ${errorMessage(error)}`,
        unresolved,
        recoveryLegs,
        { cause: error }
      );
    await safeHook(() => hooks.onManualInterventionRequired?.({ reason: manual.message, inventory: unresolved, error: manual }));
    throw manual;
  }
}

export function repriceLiveOpportunity(
  opportunity: Opportunity,
  settings: BotSettings,
  books: OrderBook[],
  options: MarketOptions,
  now = Date.now()
) {
  return findTriangularOpportunities({
    books,
    options,
    capitalToman: opportunity.requestedInputToman,
    now,
    tomanFeeBps: settings.tomanTakerFeeBps,
    usdtFeeBps: settings.usdtTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    maxPriceImpactBps: settings.maxPriceImpactBps,
    maxSpreadBps: settings.maxSpreadBps,
    depthUsagePercent: settings.orderbookDepthUsagePercent,
    minProfitBps: settings.minProfitBps,
    minNetProfitToman: settings.minNetProfitToman,
    liveSafetyBufferBps: settings.liveSafetyBufferBps,
    maxAgeMs: settings.orderbookMaxAgeMs
  }).find(candidate => candidate.id === opportunity.id && candidate.executable);
}

export function assertLiveCredentials() {
  if (!config.BITGET_API_KEY || !config.BITGET_API_SECRET || !config.BITGET_API_PASSPHRASE) {
    throw new Error("Bitget API key, secret, and passphrase are required for Live execution");
  }
}

export async function waitForFinalOrder(client: LiveExecutionClient, initial: BitgetOrder, orderTimeoutMs: number) {
  const deadline = Date.now() + orderTimeoutMs;
  let order = initial;
  while (Date.now() < deadline) {
    if (isTerminalOrderStatus(order.status)) return order;
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      order = await client.getOrderStatus(order.id);
    } catch {
      // A transient status failure is retried until the deadline; no second order is submitted meanwhile.
    }
  }
  try {
    await client.cancelOrder(initial.id);
    order = await client.getOrderStatus(initial.id);
    if (isTerminalOrderStatus(order.status)) return order;
  } catch (error) {
    throw new LiveOrderStateUnknownError(
      initial.id,
      `Order ${initial.id} timed out and its terminal state could not be confirmed after cancellation`,
      { cause: error }
    );
  }
  throw new LiveOrderStateUnknownError(initial.id, `Order ${initial.id} remained active after automatic cancellation`);
}

type FillMarket = string | Pick<OrderBook, "base" | "quote">;

export function realizedOrderOutput(side: Side, market: FillMarket, order: BitgetOrder) {
  const { base, quote } = fillMarketAssets(market);
  const outputAsset = side === "BUY" ? base : quote;
  const gross = side === "BUY" ? order.matchedAmount : order.totalPrice;
  if (!outputAsset && !order.feeAsset && !order.feeBreakdown?.length) {
    return Decimal.max(gross.minus(order.fee.abs()), 0);
  }
  const outputFees = normalizedOrderFees(order, outputAsset)
    .filter(fee => fee.asset === outputAsset)
    .reduce((total, fee) => total.plus(fee.amount), new Decimal(0));
  return Decimal.max(gross.minus(outputFees), 0);
}

export function realizedOrderInput(side: Side, market: FillMarket, order: BitgetOrder) {
  const { base, quote } = fillMarketAssets(market);
  const inputAsset = side === "BUY" ? quote : base;
  const gross = side === "BUY" ? order.totalPrice : order.matchedAmount;
  const inputFees = normalizedOrderFees(order, side === "BUY" ? base : quote)
    .filter(fee => fee.asset === inputAsset)
    .reduce((total, fee) => total.plus(fee.amount), new Decimal(0));
  return gross.plus(inputFees);
}

function isTerminalOrderStatus(status: string) {
  return ["filled", "cancelled", "canceled", "rejected", "failed", "expired", "done"]
    .includes(status.trim().toLowerCase());
}

function normalizeOrderPrice(price: Decimal) {
  return new Decimal(price);
}

function fillMarketAssets(market: FillMarket) {
  return typeof market === "string"
    ? { base: undefined, quote: market.trim().toUpperCase() }
    : { base: market.base.trim().toUpperCase(), quote: market.quote.trim().toUpperCase() };
}

function normalizedFeeAsset(order: BitgetOrder, fallback?: string) {
  const explicit = order.feeAsset?.trim().toUpperCase();
  if (explicit) return explicit;
  const breakdown = normalizedOrderFees(order);
  if (breakdown.length) return breakdown.length === 1 ? breakdown[0]!.asset : undefined;
  return fallback?.trim().toUpperCase();
}

function normalizedOrderFees(order: BitgetOrder, fallback?: string) {
  const merged = new Map<string, Decimal>();
  const authoritative = order.feeBreakdown?.length
    ? order.feeBreakdown
    : !order.fee.isZero()
      ? [{ asset: order.feeAsset ?? fallback ?? "", amount: order.fee.abs() }]
      : [];
  for (const fee of authoritative) {
    const asset = fee.asset.trim().toUpperCase();
    const amount = new Decimal(fee.amount).abs();
    if (!asset || !amount.isFinite() || amount.lte(0)) continue;
    merged.set(asset, (merged.get(asset) ?? new Decimal(0)).plus(amount));
  }
  return [...merged].map(([asset, amount]) => ({ asset, amount }));
}

function serializedFeeBreakdown(order: BitgetOrder, fallback?: string) {
  return normalizedOrderFees(order, fallback)
    .map(fee => ({ asset: fee.asset, amount: fee.amount.toString() }));
}

function mergeRecoveryPositions(positions: RecoveryPosition[]) {
  const merged = new Map<string, Decimal>();
  for (const position of positions) {
    const asset = position.asset.trim().toUpperCase();
    if (!asset || asset === "USDT" || !position.amount.isFinite() || position.amount.lte(0)) continue;
    merged.set(asset, (merged.get(asset) ?? new Decimal(0)).plus(position.amount));
  }
  return positionsFromMap(merged);
}

function positionsFromMap(positions: Map<string, Decimal>) {
  return [...positions.entries()]
    .filter(([, amount]) => amount.gt(0))
    .map(([asset, amount]) => ({ asset, amount: new Decimal(amount) }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

function clonePositions(positions: RecoveryPosition[]) {
  return positions.map(position => ({ asset: position.asset, amount: new Decimal(position.amount) }));
}

type PreparedRecoveryOrder = {
  book: OrderBook;
  edge: ConversionEdge;
  quote: NonNullable<ReturnType<typeof quoteEdge>>;
  amountBase: Decimal;
  protection: ReturnType<typeof protectedMarketOrder>;
};

function recoveryConversionEdges(books: OrderBook[], asset: string): ConversionEdge[] {
  const normalized = asset.trim().toUpperCase();
  const edges: ConversionEdge[] = [];
  for (const book of books) {
    const base = book.base.trim().toUpperCase();
    const quote = book.quote.trim().toUpperCase();
    if (base === normalized && quote === "USDT") {
      edges.push({
        id: `${book.symbol}:SELL:RECOVERY`, from: normalized, to: "USDT",
        side: "SELL" as const, book
      });
    } else if (base === "USDT" && quote === normalized) {
      edges.push({
        id: `${book.symbol}:BUY:RECOVERY`, from: normalized, to: "USDT",
        side: "BUY" as const, book
      });
    }
  }
  return edges;
}

function prepareRecoveryOrder(
  asset: string,
  availableInput: Decimal,
  books: OrderBook[],
  options: MarketOptions,
  settings: BotSettings,
  now: number
): PreparedRecoveryOrder | undefined {
  const routes = recoveryConversionEdges(books, asset);
  if (!routes.length) throw new Error(`No Bitget Spot market can convert ${asset} to USDT`);
  const fresh = routes.filter(route => bookIsFreshAndOpen(route.book, now, settings.orderbookMaxAgeMs));
  if (!fresh.length) throw new Error(`All Bitget recovery orderbooks for ${asset}/USDT are stale, empty, or crossed`);

  const prepared: PreparedRecoveryOrder[] = [];
  const hardFailures: string[] = [];
  for (const edge of fresh) {
    try {
      const amountStep = officialStep(options.amountSteps, edge.book.symbol, "amount");
      const priceStep = officialStep(options.priceSteps, edge.book.symbol, "price");
      let quote = quoteEdge(
        edge,
        availableInput,
        feeForMarket(edge.book, options, settings),
        settings.slippageBufferBps,
        settings.orderbookDepthUsagePercent
      );
      if (!quote) throw new Error(`Insufficient reserved depth on ${edge.book.symbol}`);
      assertLiquiditySafe(quote, settings, "during automatic recovery");
      const protection = protectedMarketOrder(quote, priceStep, settings);
      const amountBase = safeOrderAmountBase(
        edge.side, availableInput, quote, amountStep, protection.maximumBuyFillPrice
      );
      if (amountBase.lte(0)) continue;
      if (edge.side === "SELL" && !amountBase.eq(availableInput)) {
        const roundedQuote = quoteEdge(
          edge,
          amountBase,
          feeForMarket(edge.book, options, settings),
          settings.slippageBufferBps,
          settings.orderbookDepthUsagePercent
        );
        if (!roundedQuote) throw new Error(`Insufficient reserved depth on ${edge.book.symbol}`);
        quote = roundedQuote;
      }
      try {
        assertMinimumOrder(edge.book, edge.side, amountBase, quote, options, books);
      } catch (error) {
        if (errorMessage(error).includes("below")) continue;
        throw error;
      }
      prepared.push({ book: edge.book, edge, quote, amountBase, protection });
    } catch (error) {
      hardFailures.push(errorMessage(error));
    }
  }
  if (!prepared.length) {
    if (hardFailures.length) throw new Error(hardFailures.join("; "));
    return undefined;
  }
  return prepared.sort((a, b) => {
    const aOutput = a.edge.side === "BUY" ? a.amountBase : a.quote.output;
    const bOutput = b.edge.side === "BUY" ? b.amountBase : b.quote.output;
    return bOutput.comparedTo(aOutput);
  })[0];
}

function recoveryValueInUsdt(
  asset: string,
  amount: Decimal,
  books: OrderBook[],
  options: MarketOptions,
  settings: BotSettings,
  now: number,
  strictRisk: boolean
) {
  const routes = recoveryConversionEdges(books, asset)
    .filter(route => bookIsFreshAndOpen(route.book, now, settings.orderbookMaxAgeMs));
  const values: Decimal[] = [];
  const failures: string[] = [];
  for (const edge of routes) {
    const quote = quoteEdge(
      edge,
      amount,
      feeForMarket(edge.book, options, settings),
      settings.slippageBufferBps,
      settings.orderbookDepthUsagePercent
    );
    if (!quote) continue;
    try {
      assertLiquiditySafe(quote, settings, "while valuing USDT recovery");
      values.push(quote.output);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  if (values.length) return Decimal.max(...values);
  if (strictRisk && failures.length) throw new Error(failures.join("; "));
  return undefined;
}

async function valueExternalFeesInUsdt(
  legs: ExecutionLeg[],
  client: LiveExecutionClient,
  options: MarketOptions,
  settings: BotSettings
) {
  const debits = new Map<string, Decimal>();
  for (const leg of legs) {
    const inputAsset = leg.inputAsset?.trim().toUpperCase();
    const outputAsset = leg.outputAsset?.trim().toUpperCase();
    const fees = leg.feeBreakdown?.length
      ? leg.feeBreakdown
      : [{ asset: leg.feeAsset ?? "", amount: leg.fee }];
    for (const component of fees) {
      const feeAsset = component.asset.trim().toUpperCase();
      const fee = new Decimal(component.amount || 0).abs();
      if (!feeAsset || !fee.isFinite() || fee.lte(0) || feeAsset === inputAsset || feeAsset === outputAsset) continue;
      debits.set(feeAsset, (debits.get(feeAsset) ?? new Decimal(0)).plus(fee));
    }
  }
  if (!debits.size) return new Decimal(0);

  const books = await client.getAllOrderBooks();
  const now = Date.now();
  let total = new Decimal(0);
  for (const [asset, amount] of debits) {
    if (asset === "USDT") {
      total = total.plus(amount);
      continue;
    }
    const replacementCost = externalFeeReplacementCostInUsdt(asset, amount, books, options, settings, now);
    if (!replacementCost) {
      throw new Error(`Cannot value external Bitget fee ${amount.toString()} ${asset}; economic PnL was not recorded`);
    }
    total = total.plus(replacementCost);
  }
  return total;
}

function externalFeeReplacementCostInUsdt(
  asset: string,
  amount: Decimal,
  books: OrderBook[],
  options: MarketOptions,
  settings: BotSettings,
  now: number
) {
  const normalized = asset.trim().toUpperCase();
  const edges: ConversionEdge[] = [];
  for (const book of books) {
    if (!bookIsFreshAndOpen(book, now, settings.orderbookMaxAgeMs)) continue;
    const base = book.base.trim().toUpperCase();
    const quote = book.quote.trim().toUpperCase();
    if (base === normalized && quote === "USDT") {
      edges.push({ id: `${book.symbol}:BUY:FEE`, from: "USDT", to: normalized, side: "BUY", book });
    } else if (base === "USDT" && quote === normalized) {
      edges.push({ id: `${book.symbol}:SELL:FEE`, from: "USDT", to: normalized, side: "SELL", book });
    }
  }

  const costs: Decimal[] = [];
  for (const edge of edges) {
    const ratio = new Decimal(settings.orderbookDepthUsagePercent).div(100);
    const levels = edge.side === "BUY" ? edge.book.asks : edge.book.bids;
    const maximumInput = levels.reduce((total, level) => {
      if (level.price.lte(0) || level.amount.lte(0)) return total;
      return total.plus(edge.side === "BUY"
        ? level.amount.mul(level.price).mul(ratio)
        : level.amount.mul(ratio));
    }, new Decimal(0));
    if (maximumInput.lte(0)) continue;
    const feeBps = feeForMarket(edge.book, options, settings);
    const maximumQuote = quoteEdge(
      edge, maximumInput, feeBps, settings.slippageBufferBps, settings.orderbookDepthUsagePercent
    );
    if (!maximumQuote || maximumQuote.output.lt(amount)) continue;

    let low = new Decimal(0);
    let high = maximumInput;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const middle = low.plus(high).div(2);
      const quote = quoteEdge(
        edge, middle, feeBps, settings.slippageBufferBps, settings.orderbookDepthUsagePercent
      );
      if (quote && quote.output.gte(amount)) high = middle;
      else low = middle;
    }
    const quote = quoteEdge(
      edge, high, feeBps, settings.slippageBufferBps, settings.orderbookDepthUsagePercent
    );
    if (!quote) continue;
    assertLiquiditySafe(quote, settings, "while valuing an external Bitget fee");
    costs.push(high);
  }
  return costs.length ? Decimal.min(...costs) : undefined;
}

function assertFreshRecoveryBook(book: OrderBook, now: number, maxAgeMs: number) {
  if (!bookIsFreshAndOpen(book, now, maxAgeMs)) {
    throw new Error(`Recovery orderbook ${book.symbol} is stale or has an invalid timestamp`);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function uniqueClientOrderId(prefix: "tri" | "trr", ordinal: number) {
  const entropy = randomUUID().replaceAll("-", "").slice(0, 10);
  return `${prefix}-${Date.now().toString(36)}-${ordinal.toString(36)}-${entropy}`.slice(0, 32);
}

async function safeHook(call: () => Promise<unknown> | unknown) {
  try { await call(); } catch { /* Logging must never strand an exposed intermediate balance. */ }
}

function realizedInitialUsdtInput(from: string, side: Side, book: Pick<OrderBook, "base" | "quote">, order: BitgetOrder) {
  if (from.trim().toUpperCase() !== "USDT") {
    throw new Error("The first live Bitget leg must consume USDT");
  }
  return realizedOrderInput(side, book, order);
}

function floorStep(value: Decimal, step: Decimal) { return value.div(step).floor().mul(step); }

/** Round the Bitget IOC limit away from the unprotected side. */
export function priceToOutwardStep(side: Side, value: Decimal, step: Decimal) {
  if (!step.isFinite() || step.lte(0)) throw new Error("A positive official price step is required");
  const units = value.div(step);
  return (side === "BUY" ? units.ceil() : units.floor()).mul(step);
}

export function safeOrderAmountBase(
  side: Side,
  availableInput: Decimal,
  quote: NonNullable<ReturnType<typeof quoteEdge>>,
  amountStep: Decimal,
  maximumBuyFillPrice: Decimal
) {
  if (!amountStep.isFinite() || amountStep.lte(0)) throw new Error("A positive official amount step is required");
  const raw = side === "SELL"
    ? availableInput
    : Decimal.min(quote.grossOutput, availableInput.div(maximumBuyFillPrice));
  return floorStep(raw, amountStep);
}

// The adapter submits this protected price as the IOC limit; no hidden exchange range is assumed.
function protectedExpectedPrice(side: Side, worst: Decimal, settings: BotSettings) {
  const tolerance = new Decimal(settings.slippageBufferBps).div(10_000);
  return side === "BUY"
    ? worst.mul(new Decimal(1).plus(tolerance))
    : worst.mul(new Decimal(1).minus(tolerance));
}

export function protectedMarketOrder(
  quote: NonNullable<ReturnType<typeof quoteEdge>>,
  priceStep: Decimal,
  settings: BotSettings
) {
  const side = quote.edge.side;
  const expectedPrice = priceToOutwardStep(side, protectedExpectedPrice(side, quote.worstPrice, settings), priceStep);
  if (!expectedPrice.isFinite() || expectedPrice.lte(0)) {
    throw new Error(`Protected market price rounded to an invalid value on ${quote.edge.book.symbol}`);
  }
  const minimumSellFillPrice = expectedPrice;
  const maximumBuyFillPrice = expectedPrice;
  const levels = side === "BUY"
    ? quote.edge.book.asks.filter(level => level.price.gt(0) && level.amount.gt(0)).sort((a, b) => a.price.comparedTo(b.price))
    : quote.edge.book.bids.filter(level => level.price.gt(0) && level.amount.gt(0)).sort((a, b) => b.price.comparedTo(a.price));
  const usedLevels = levels.slice(0, quote.levelsUsed);
  const covered = usedLevels.length === quote.levelsUsed && usedLevels.every(level => side === "BUY"
    ? level.price.lte(maximumBuyFillPrice)
    : level.price.gte(minimumSellFillPrice));
  if (!covered) {
    throw new Error(`Protected market price does not cover every simulated level on ${quote.edge.book.symbol}`);
  }
  return { expectedPrice, minimumSellFillPrice, maximumBuyFillPrice };
}

function feeForMarket(book: Pick<OrderBook, "symbol" | "quote">, options: MarketOptions, settings: BotSettings) {
  const symbolFee = marketOption(options.takerFeeBpsBySymbol, book.symbol, true);
  return symbolFee ?? (book.quote.trim().toUpperCase() === "USDT"
    ? settings.tomanTakerFeeBps
    : settings.usdtTakerFeeBps);
}

function assertLiquiditySafe(quote: NonNullable<ReturnType<typeof quoteEdge>>, settings: BotSettings, phase: string) {
  if (quote.spreadBps.gt(settings.maxSpreadBps)) {
    throw new Error(`Spread too high on ${quote.edge.book.symbol} ${phase}: ${quote.spreadBps.toFixed(2)} BPS`);
  }
  if (quote.priceImpactBps.gt(settings.maxPriceImpactBps)) {
    throw new Error(`Price impact too high on ${quote.edge.book.symbol} ${phase}: ${quote.priceImpactBps.toFixed(2)} BPS`);
  }
}

function requiredLiveProfit(input: Decimal, settings: BotSettings) {
  const requiredBps = new Decimal(settings.minProfitBps).plus(settings.liveSafetyBufferBps);
  return Decimal.max(settings.minNetProfitToman, input.mul(requiredBps).div(10_000));
}

function assertLiveSafetyMargin(opportunity: Opportunity, settings: BotSettings, phase: string) {
  const rejection = liveSafetyRejectionReason(opportunity, settings);
  if (rejection) throw new Error(`${phase}: ${rejection}؛ هیچ سفارشی ارسال نشد`);
}

export function liveSafetyRejectionReason(opportunity: Opportunity, settings: BotSettings) {
  const required = requiredLiveProfit(opportunity.inputToman, settings);
  return opportunity.netProfitToman.lt(required)
    ? `سود ${opportunity.netProfitToman.toFixed(0)} USDT از حد امن Live ${required.toFixed(0)} USDT کمتر است`
    : undefined;
}

function assertProjectedFinal(projectedFinal: Decimal, input: Decimal, settings: BotSettings, legIndex: number) {
  const requiredFinal = input.plus(requiredLiveProfit(input, settings));
  if (projectedFinal.lt(requiredFinal)) {
    throw new Error(`گارد سود انتهابه‌انتها قبل از سفارش ${legIndex + 1} فعال شد: خروجی برآوردی ${projectedFinal.toFixed(0)} کمتر از حد امن ${requiredFinal.toFixed(0)} USDT است`);
  }
}

function projectRemainingOutput(
  plannedQuotes: Opportunity["legs"],
  start: number,
  input: Decimal,
  inventory: LiveInventory,
  books: OrderBook[],
  options: MarketOptions,
  settings: BotSettings
) {
  const simulated: LiveInventory = {};
  for (const [asset, amount] of Object.entries(inventory)) {
    if (asset.toUpperCase() !== "USDT" && amount.gt(0)) simulated[asset.toUpperCase()] = new Decimal(amount);
  }
  const startingAsset = plannedQuotes[start]?.edge.from;
  if (!startingAsset) return undefined;
  simulated[startingAsset] = new Decimal(input);
  for (let i = start; i < plannedQuotes.length; i += 1) {
    const planned = plannedQuotes[i];
    const book = books.find(item => item.symbol === planned.edge.book.symbol);
    if (!book) return undefined;
    const edge = { ...planned.edge, book };
    const available = simulated[edge.from] ?? new Decimal(0);
    let quote = quoteEdge(edge, available, feeForMarket(book, options, settings), settings.slippageBufferBps, settings.orderbookDepthUsagePercent);
    if (!quote || quote.spreadBps.gt(settings.maxSpreadBps) || quote.priceImpactBps.gt(settings.maxPriceImpactBps)) return undefined;
    const amountStep = officialStep(options.amountSteps, book.symbol, "amount");
    if (edge.side === "BUY") {
      const priceStep = officialStep(options.priceSteps, book.symbol, "price");
      const protection = protectedMarketOrder(quote, priceStep, settings);
      const amountBase = safeOrderAmountBase("BUY", available, quote, amountStep, protection.maximumBuyFillPrice);
      if (amountBase.lte(0)) return undefined;
      assertMinimumOrder(book, edge.side, amountBase, quote, options, books);
      const feeRetention = new Decimal(1).minus(new Decimal(feeForMarket(book, options, settings)).div(10_000));
      const slipRetention = new Decimal(1).minus(new Decimal(settings.slippageBufferBps).div(10_000));
      const maximumSpend = Decimal.min(available, amountBase.mul(protection.maximumBuyFillPrice));
      simulated[edge.from] = Decimal.max(available.minus(maximumSpend), 0);
      simulated[edge.to] = (simulated[edge.to] ?? new Decimal(0)).plus(amountBase.mul(feeRetention).mul(slipRetention));
    } else {
      const amountBase = floorStep(available, amountStep);
      if (amountBase.lte(0)) return undefined;
      quote = quoteEdge(edge, amountBase, feeForMarket(book, options, settings), settings.slippageBufferBps, settings.orderbookDepthUsagePercent);
      if (!quote) return undefined;
      assertMinimumOrder(book, edge.side, amountBase, quote, options, books);
      simulated[edge.from] = Decimal.max(available.minus(amountBase), 0);
      simulated[edge.to] = (simulated[edge.to] ?? new Decimal(0)).plus(quote.output);
    }
  }
  return Object.entries(simulated).reduce<Decimal | undefined>((total, [asset, amount]) => {
    if (!total || amount.lte(0)) return total;
    if (asset === "USDT") return total.plus(amount);
    const value = recoveryValueInUsdt(asset, amount, books, options, settings, Date.now(), false);
    return value ? total.plus(value) : undefined;
  }, new Decimal(0));
}

function officialStep(steps: Record<string, Decimal>, symbol: string, kind: "amount" | "price") {
  const step = steps[symbol] ?? steps[symbol.toUpperCase()];
  if (!step?.isFinite() || step.lte(0)) {
    throw new Error(`Official ${kind} precision is unavailable for ${symbol}; Live execution failed closed`);
  }
  return step;
}

function assertMinimumOrder(
  book: OrderBook,
  side: Side,
  amountBase: Decimal,
  quote: NonNullable<ReturnType<typeof quoteEdge>>,
  options: MarketOptions,
  books: OrderBook[]
) {
  const conservativeQuoteAmount = amountBase.mul(side === "BUY" ? quote.bestPrice : quote.worstPrice);
  const quoteMinimum = marketOption(options.minOrderQuoteBySymbol, book.symbol);
  if (quoteMinimum) {
    if (conservativeQuoteAmount.lt(quoteMinimum)) {
      throw new Error(`Rounded ${book.symbol} order is below the official ${quoteMinimum.toString()} ${book.quote} minimum`);
    }
    return;
  }

  const usdtMinimum = marketOption(options.minTradeUsdtBySymbol, book.symbol)
    ?? (options.minOrderUsdt.isFinite() && options.minOrderUsdt.gt(0) ? options.minOrderUsdt : undefined);
  if (!usdtMinimum) throw new Error(`Official Bitget minimum is unavailable for ${book.symbol}`);
  const usdtValue = conservativeUsdtValue(book.quote, conservativeQuoteAmount, books);
  if (!usdtValue) {
    throw new Error(`Cannot value the ${book.quote} notional of ${book.symbol} in USDT to enforce minTradeUSDT`);
  }
  if (usdtValue.lt(usdtMinimum)) {
    throw new Error(`Rounded ${book.symbol} order is worth ${usdtValue.toString()} USDT, below Bitget minTradeUSDT ${usdtMinimum.toString()}`);
  }
}

function marketOption(values: Record<string, Decimal> | undefined, symbol: string, allowZero = false) {
  if (!values) return undefined;
  const value = values[symbol] ?? values[symbol.toUpperCase()];
  return value?.isFinite() && (allowZero ? value.gte(0) : value.gt(0)) ? value : undefined;
}

function conservativeUsdtValue(asset: string, amount: Decimal, books: OrderBook[]) {
  const normalized = asset.trim().toUpperCase();
  if (normalized === "USDT") return amount;
  const values: Decimal[] = [];
  for (const book of books) {
    const base = book.base.trim().toUpperCase();
    const quote = book.quote.trim().toUpperCase();
    if (base === normalized && quote === "USDT") {
      const bid = bestBookPrice(book.bids, "MAX");
      if (bid) values.push(amount.mul(bid));
    } else if (base === "USDT" && quote === normalized) {
      const ask = bestBookPrice(book.asks, "MIN");
      if (ask) values.push(amount.div(ask));
    }
  }
  return values.length ? Decimal.min(...values) : undefined;
}

function bestBookPrice(levels: OrderBook["bids"], mode: "MIN" | "MAX") {
  return levels
    .filter(level => level.price.gt(0) && level.amount.gt(0))
    .reduce<Decimal | undefined>((best, level) => {
      if (!best) return level.price;
      return mode === "MIN" ? Decimal.min(best, level.price) : Decimal.max(best, level.price);
    }, undefined);
}

function assertExecutionSnapshot(
  books: OrderBook[],
  plannedQuotes: Opportunity["legs"],
  settings: BotSettings,
  now: number
) {
  const selected = plannedQuotes.map(planned => {
    const book = books.find(item => item.symbol === planned.edge.book.symbol);
    if (!book) throw new Error(`Orderbook ${planned.edge.book.symbol} disappeared before submission`);
    if (!bookIsFreshAndOpen(book, now, settings.orderbookMaxAgeMs)) {
      throw new Error(`Orderbook ${book.symbol} is stale, future-dated, empty, or crossed; no order was sent`);
    }
    return book;
  });
  const timestamps = selected.map(book => book.lastUpdate);
  const maxSkew = Math.min(settings.orderbookMaxAgeMs, 1_000);
  if (Math.max(...timestamps) - Math.min(...timestamps) > maxSkew) {
    throw new Error(`Selected orderbooks are not synchronized within ${maxSkew}ms; no order was sent`);
  }
}

function bookIsFreshAndOpen(book: OrderBook, now: number, maxAgeMs: number) {
  const bestBid = book.bids.filter(level => level.price.gt(0) && level.amount.gt(0))
    .reduce<Decimal | undefined>((best, level) => !best || level.price.gt(best) ? level.price : best, undefined);
  const bestAsk = book.asks.filter(level => level.price.gt(0) && level.amount.gt(0))
    .reduce<Decimal | undefined>((best, level) => !best || level.price.lt(best) ? level.price : best, undefined);
  return Number.isFinite(book.lastUpdate)
    && book.lastUpdate > 0
    && now - book.lastUpdate <= maxAgeMs
    && book.lastUpdate - now <= 1_000
    && Boolean(bestBid && bestAsk && bestBid.lt(bestAsk));
}

function valueResidualDust(
  residuals: RecoveryPosition[],
  books: OrderBook[],
  options: MarketOptions,
  settings: BotSettings,
  now: number
) {
  return residuals.reduce((total, residual) => {
    const value = recoveryValueInUsdt(residual.asset, residual.amount, books, options, settings, now, true);
    if (!value) throw new Error(`Cannot value residual ${residual.asset} through a fresh Bitget market to USDT`);
    return total.plus(value);
  }, new Decimal(0));
}

type MarketSubmission = {
  side: Side;
  base: string;
  quote: string;
  amountBase: Decimal;
  expectedPrice: Decimal;
  clientOrderId: string;
};

export async function submitOrReconcile(client: LiveExecutionClient, input: MarketSubmission, unknownOrderId: string) {
  try {
    return await client.placeMarketOrder(input);
  } catch (submissionError) {
    if (isDefinitiveSubmissionRejection(submissionError)) throw submissionError;
    if (client.getOrderStatusByClientOrderId) {
      let reconciliationError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 150));
        try {
          return await client.getOrderStatusByClientOrderId(input.clientOrderId);
        } catch (error) {
          reconciliationError = error;
        }
      }
      throw new LiveOrderStateUnknownError(
        unknownOrderId,
        `Submission outcome for ${input.clientOrderId} remains unknown after clientOrderId reconciliation`,
        { cause: reconciliationError ?? submissionError }
      );
    }
    throw new LiveOrderStateUnknownError(
      unknownOrderId,
      `Submission outcome for ${input.clientOrderId} is unknown and the adapter cannot reconcile clientOrderId`,
      { cause: submissionError }
    );
  }
}

function isDefinitiveSubmissionRejection(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
  return message.startsWith("order rejected:")
    || message.startsWith("bitget order rejected:")
    || message.startsWith("margin order rejected:");
}
