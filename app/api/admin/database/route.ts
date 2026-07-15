import { NextResponse } from "next/server";
import { z } from "zod";
import {
  countUnsafeLiveExecutionRecords,
  purgeAllOpportunityDatabaseData
} from "@/lib/opportunity-store";
import {
  countUnsafeStrategyExecutionRecords,
  purgeAllStrategyExecutionData
} from "@/lib/strategy-execution-store";
import { purgeAllExecutionLedgerData } from "@/lib/execution-ledger";
import { getRiskControlSnapshot, listExecutionLeases } from "@/lib/risk/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requestSchema = z.object({
  confirmation: z.literal("DELETE_ALL_DATABASE_DATA")
}).strict();

type AdminDatabasePurgeDependencies = {
  riskSnapshot: typeof getRiskControlSnapshot;
  executionLeases: typeof listExecutionLeases;
  unsafeTriangleRecords: typeof countUnsafeLiveExecutionRecords;
  unsafeStrategyRecords: typeof countUnsafeStrategyExecutionRecords;
  purgeOpportunityDatabase: typeof purgeAllOpportunityDatabaseData;
  purgeStrategyDatabase: typeof purgeAllStrategyExecutionData;
  purgeExecutionLedger: typeof purgeAllExecutionLedgerData;
};

const defaultDependencies: AdminDatabasePurgeDependencies = {
  riskSnapshot: getRiskControlSnapshot,
  executionLeases: listExecutionLeases,
  unsafeTriangleRecords: countUnsafeLiveExecutionRecords,
  unsafeStrategyRecords: countUnsafeStrategyExecutionRecords,
  purgeOpportunityDatabase: purgeAllOpportunityDatabaseData,
  purgeStrategyDatabase: purgeAllStrategyExecutionData,
  purgeExecutionLedger: purgeAllExecutionLedgerData
};

export async function DELETE(request: Request) {
  return handleAdminDatabasePurge(request);
}

export async function handleAdminDatabasePurge(
  request: Request,
  dependencies: AdminDatabasePurgeDependencies = defaultDependencies
) {
  if (!isDashboardAdminRequest(request)) {
    return NextResponse.json({ error: "حذف کامل دیتابیس فقط از داشبورد همین برنامه مجاز است" }, { status: 403 });
  }

  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({
      error: "عبارت تأیید حذف کامل دیتابیس صحیح نیست",
      issues: error instanceof z.ZodError ? error.issues : undefined
    }, { status: 400 });
  }
  void input;

  try {
    const risk = await dependencies.riskSnapshot();
    if (risk.state.masterArmed) {
      return NextResponse.json({ error: "برای حذف کامل دیتابیس ابتدا اجرای کلی معاملات واقعی را خاموش کنید" }, { status: 409 });
    }

    const leases = await dependencies.executionLeases();
    if (leases.length > 0) {
      return NextResponse.json({ error: "یک اجرای واقعی یا Recovery هنوز Lease فعال دارد؛ حذف دیتابیس متوقف شد" }, { status: 409 });
    }

    const [unsafeTriangle, unsafeStrategies] = await Promise.all([
      dependencies.unsafeTriangleRecords(),
      dependencies.unsafeStrategyRecords()
    ]);
    if (unsafeTriangle > 0 || unsafeStrategies > 0) {
      return NextResponse.json({
        error: "رکورد دارای اجرای باز، Recovery یا سفارش تعیین‌تکلیف‌نشده وجود دارد؛ ابتدا آن را بررسی و تسویه کنید",
        unsafeRecords: { triangle: unsafeTriangle, strategies: unsafeStrategies }
      }, { status: 409 });
    }

    // A second server-owned fence immediately before destructive writes closes
    // the gap between the first safety check and database deletion.
    const [latestRisk, latestLeases] = await Promise.all([
      dependencies.riskSnapshot(),
      dependencies.executionLeases()
    ]);
    if (latestRisk.state.masterArmed || latestLeases.length > 0) {
      return NextResponse.json({ error: "وضعیت اجرای واقعی هنگام بررسی تغییر کرد؛ حذف دیتابیس لغو شد" }, { status: 409 });
    }

    const opportunities = await dependencies.purgeOpportunityDatabase();
    const strategies = await dependencies.purgeStrategyDatabase();
    const ledger = await dependencies.purgeExecutionLedger();
    return NextResponse.json({
      status: "purged",
      deleted: {
        opportunities,
        strategies,
        ledger,
        total: opportunities.total + strategies.total + ledger.total
      },
      preserved: ["bot-settings", "risk-state", "environment", "api-credentials"]
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "خطا در حذف کامل دیتابیس"
    }, { status: 500 });
  }
}

export function isDashboardAdminRequest(request: Request) {
  if (request.headers.get("x-admin-action") !== "purge-all-database-data") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
