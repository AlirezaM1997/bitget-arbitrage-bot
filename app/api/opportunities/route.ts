import { NextResponse } from "next/server";
import { clearOpportunityHistory, getOpportunityHistory } from "@/lib/opportunity-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    return NextResponse.json(await getOpportunityHistory(limit));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در خواندن تاریخچه فرصت‌ها" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isDashboardClearRequest(request)) {
    return NextResponse.json({ error: "پاک‌سازی تاریخچه فقط از داشبورد همین برنامه مجاز است" }, { status: 403 });
  }
  try {
    const deletedCount = await clearOpportunityHistory();
    return NextResponse.json({ archivedCount: deletedCount, deletedCount, history: await getOpportunityHistory(50) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در پاک‌سازی تاریخچه فرصت‌ها" }, { status: 500 });
  }
}

function isDashboardClearRequest(request: Request) {
  if (request.headers.get("x-history-action") !== "clear-opportunity-history") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
