import { expect, test } from "bun:test";
import Decimal from "decimal.js";
import type { Opportunity } from "@/lib/bot/types";
import { defaultBotSettings } from "@/lib/bot-settings";

process.env.OPPORTUNITY_DB_PATH = ":memory:";

const opportunity: Opportunity = {
  id: "USDTUSDT:BUY|BTCUSDT:BUY|BTCUSDT:SELL",
  route: ["USDT", "USDT", "BTC", "USDT"],
  legs: [],
  requestedInputToman: new Decimal(1_000_000),
  inputToman: new Decimal(1_000_000),
  outputToman: new Decimal(1_020_000),
  netProfitToman: new Decimal(20_000),
  profitBps: new Decimal(200),
  liquiditySafe: true,
  executable: true,
  sizedByDepth: false,
  sizingMode: "optimized",
  scannedAt: 1_800_000_000_000
};

test("stores profitable detections in one route-minute record", async () => {
  const { getOpportunityHistory, saveProfitableOpportunities } = await import("@/lib/opportunity-store");
  expect(await saveProfitableOpportunities([opportunity], "paper")).toBe(1);
  expect(await saveProfitableOpportunities([{ ...opportunity, netProfitToman: new Decimal(25_000) }], "paper")).toBe(1);
  expect(await saveProfitableOpportunities([{ ...opportunity, liquiditySafe: false }], "paper")).toBe(0);
  const history = await getOpportunityHistory();
  expect(history.summary.recordCount).toBe(1);
  expect(history.summary.detectionCount).toBe(2);
  expect(history.records[0]?.bestProfitToman).toBe(25_000);
});

test("persists a completed live execution and its real order ids", async () => {
  const {
    clearOpportunityHistory,
    completeLiveExecution,
    createLiveExecutionAttempt,
    createLiveExecutionTrigger,
    failLiveExecution,
    getLiveExecutionHistory,
    getOpportunityHistory,
    markLiveExecutionPrepared,
    saveProfitableOpportunities,
    updateLiveExecutionOrders
  } = await import("@/lib/opportunity-store");
  const id = await createLiveExecutionAttempt(opportunity);
  await markLiveExecutionPrepared(id, { ...opportunity, inputToman: new Decimal(500_000), outputToman: new Decimal(510_000), netProfitToman: new Decimal(10_000) });
  const order = {
    symbol: "USDTUSDT", side: "BUY", orderId: "987654", status: "Done",
    input: "500000", expectedOutput: "5", output: "4.99", averagePrice: "100000",
    fee: "0.0125", slippageBuffer: "0.005", levelsUsed: 2, totalLevels: 24,
    depthConsumedPercent: "12.5", priceImpactBps: "4", spreadBps: "6"
  };
  await updateLiveExecutionOrders(id, [order]);
  await completeLiveExecution(id, { outputToman: new Decimal(509_500), profitToman: new Decimal(9_500), legs: [order] });

  const history = await getLiveExecutionHistory();
  const record = history.records.find(item => item.id === id);
  expect(history.summary.completedCount).toBe(1);
  expect(history.summary.totalActualProfitToman).toBe(9_500);
  expect(record?.status).toBe("COMPLETED");
  expect(record?.actualProfitToman).toBe(9_500);
  expect(record?.orders[0]?.orderId).toBe("987654");

  const rejectedId = await createLiveExecutionTrigger({ routeKey: opportunity.id, route: opportunity.route, requestedInputToman: 1_000_000 });
  await failLiveExecution(rejectedId, "بدون ارسال سفارش: فرصت در بازبینی نهایی ناپدید شد");
  const rejectedHistory = await getLiveExecutionHistory();
  const rejected = rejectedHistory.records.find(item => item.id === rejectedId);
  expect(rejectedHistory.summary.failedCount).toBe(1);
  expect(rejected?.orders).toHaveLength(0);
  expect(rejected?.error).toContain("بدون ارسال سفارش");

  const recoveredId = await createLiveExecutionAttempt(opportunity);
  await failLiveExecution(recoveredId, "cycle failed but inventory recovered", {
    actualOutputToman: 999_000,
    actualProfitToman: -1_000
  });
  const recoveredHistory = await getLiveExecutionHistory();
  const recovered = recoveredHistory.records.find(item => item.id === recoveredId);
  expect(recovered?.status).toBe("FAILED");
  expect(recovered?.actualOutputToman).toBe(999_000);
  expect(recovered?.actualProfitToman).toBe(-1_000);
  expect(recoveredHistory.summary.totalActualProfitToman).toBe(8_500);

  await saveProfitableOpportunities([opportunity], "live");
  expect(await clearOpportunityHistory()).toBeGreaterThan(0);
  expect((await getOpportunityHistory()).summary.recordCount).toBe(0);
  expect((await getLiveExecutionHistory()).summary.completedCount).toBe(1);
});

test("keeps historical criteria immutable when dashboard settings change", async () => {
  const { clearOpportunityHistory, getOpportunityHistory, saveProfitableOpportunities } = await import("@/lib/opportunity-store");
  await clearOpportunityHistory();
  const settings130 = { ...defaultBotSettings, minProfitBps: 130 };
  const settings80 = { ...defaultBotSettings, minProfitBps: 80 };
  await saveProfitableOpportunities([{ ...opportunity, executable: false, rejectionReason: "بازده 42.29 BPS کمتر از حداقل تاریخی 130.00 BPS است" }], "live", settings130);
  await saveProfitableOpportunities([{ ...opportunity, executable: false, rejectionReason: "بازده 42.29 BPS کمتر از حداقل تاریخی 80.00 BPS است" }], "live", settings80);

  const history = await getOpportunityHistory();
  expect(history.summary.recordCount).toBe(2);
  expect(history.summary.uniqueRouteCount).toBe(1);
  expect(history.records.map(record => record.settings.minProfitBps).sort((a, b) => Number(a) - Number(b))).toEqual([80, 130]);
  expect(history.records.some(record => record.rejectionReason?.includes("130.00 BPS"))).toBe(true);
  expect(history.records.some(record => record.rejectionReason?.includes("80.00 BPS"))).toBe(true);
});

test("dashboard cleanup removes safe Triangle history and preserves ambiguous executions", async () => {
  const {
    clearDashboardLiveExecutionHistory,
    createLiveExecutionTrigger,
    failLiveExecution,
    getLiveExecutionHistory,
    getUnfinishedLiveExecutions
  } = await import("@/lib/opportunity-store");

  await clearDashboardLiveExecutionHistory(Number.MAX_SAFE_INTEGER);
  const activeId = await createLiveExecutionTrigger({
    routeKey: "active-triangle",
    route: ["USDT", "USDT", "BTC", "USDT"],
    requestedInputToman: 500_000
  });
  const ambiguousId = await createLiveExecutionTrigger({
    routeKey: "ambiguous-triangle",
    route: ["USDT", "USDT", "ETH", "USDT"],
    requestedInputToman: 500_000
  });
  await failLiveExecution(ambiguousId, "exchange order state is unknown");
  const rejectedId = await createLiveExecutionTrigger({
    routeKey: "rejected-triangle",
    route: ["USDT", "USDT", "SOL", "USDT"],
    requestedInputToman: 500_000
  });
  await failLiveExecution(rejectedId, "بدون ارسال سفارش: فرصت در بازبینی نهایی رد شد");

  expect(await clearDashboardLiveExecutionHistory(0)).toBe(1);

  const history = await getLiveExecutionHistory();
  expect(history.summary.completedCount).toBe(0);
  expect(history.summary.runningCount).toBeGreaterThanOrEqual(1);
  expect(history.summary.failedCount).toBe(1);
  expect(history.records.some(record => record.id === activeId && record.status === "PREPARING")).toBe(true);
  expect(history.records.some(record => record.id === ambiguousId && record.status === "FAILED")).toBe(true);
  expect(history.records.some(record => record.id === rejectedId)).toBe(false);
  const unfinished = await getUnfinishedLiveExecutions();
  expect(unfinished.some(record => record.id === activeId && record.status === "PREPARING" && !record.ordersCorrupt)).toBe(true);
  expect(unfinished.some(record => record.id === ambiguousId)).toBe(false);
});

test("administrative purge physically removes opportunity and Triangle execution rows", async () => {
  const { getLiveExecutionHistory, getOpportunityHistory, purgeAllOpportunityDatabaseData } = await import("@/lib/opportunity-store");
  const deleted = await purgeAllOpportunityDatabaseData();
  expect(deleted.total).toBeGreaterThan(0);
  expect((await getOpportunityHistory()).summary.recordCount).toBe(0);
  expect((await getLiveExecutionHistory()).summary.attemptCount).toBe(0);
});
