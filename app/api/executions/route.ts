import { NextResponse } from "next/server";
import {
  clearDashboardLiveExecutionHistory,
  getLiveExecutionHistory
} from "@/lib/opportunity-store";
import {
  clearDashboardStrategyExecutionHistory,
  listStrategyExecutions
} from "@/lib/strategy-execution-store";
import { getRiskControlSnapshot } from "@/lib/risk/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    return NextResponse.json(await getLiveExecutionHistory(limit));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در خواندن لاگ معاملات واقعی" }, { status: 500 });
  }
}

type ExecutionHistoryClearDependencies = {
  riskSnapshot: typeof getRiskControlSnapshot;
  clearTriangle: typeof clearDashboardLiveExecutionHistory;
  clearStrategies: typeof clearDashboardStrategyExecutionHistory;
  triangleHistory: typeof getLiveExecutionHistory;
  strategyHistory: typeof listStrategyExecutions;
};

const defaultClearDependencies: ExecutionHistoryClearDependencies = {
  riskSnapshot: getRiskControlSnapshot,
  clearTriangle: clearDashboardLiveExecutionHistory,
  clearStrategies: clearDashboardStrategyExecutionHistory,
  triangleHistory: getLiveExecutionHistory,
  strategyHistory: listStrategyExecutions
};

export async function DELETE(request: Request) {
  return handleClearExecutionHistory(request);
}

export async function handleClearExecutionHistory(
  request: Request,
  dependencies: ExecutionHistoryClearDependencies = defaultClearDependencies
) {
  if (!isDashboardExecutionHistoryClearRequest(request)) {
    return NextResponse.json({ error: "پاک‌سازی تاریخچه اجراها فقط از داشبورد همین برنامه مجاز است" }, { status: 403 });
  }
  try {
    const risk = await dependencies.riskSnapshot();
    if (risk.state.masterArmed) {
      return NextResponse.json({
        error: "برای پاک کردن تاریخچه، ابتدا اجرای کلی Live را خاموش کنید. رکوردهای دارای سفارش یا پوزیشن باز حذف نمی‌شوند."
      }, { status: 409 });
    }
    const triangleDeleted = await dependencies.clearTriangle();
    const strategyDeleted = await dependencies.clearStrategies();
    const [liveExecutions, strategyExecutions] = await Promise.all([
      dependencies.triangleHistory(50),
      dependencies.strategyHistory({ limit: 50 })
    ]);
    const remainingCount = Number(liveExecutions.summary.attemptCount ?? 0)
      + Number(strategyExecutions.summary.totalCount ?? 0);
    return NextResponse.json({
      archivedCount: {
        triangle: triangleDeleted,
        strategies: strategyDeleted,
        total: triangleDeleted + strategyDeleted
      },
      // Kept for older dashboard clients; rows are archived, never deleted.
      deletedCount: {
        triangle: triangleDeleted,
        strategies: strategyDeleted,
        total: triangleDeleted + strategyDeleted
      },
      remainingCount,
      liveExecutions,
      strategyExecutions
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "خطا در پاک‌سازی تاریخچه اجراها"
    }, { status: 500 });
  }
}

export function isDashboardExecutionHistoryClearRequest(request: Request) {
  if (request.headers.get("x-history-action") !== "clear-execution-history") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
