import { NextResponse } from "next/server";
import { getLiveSchedulerStatus } from "@/lib/runtime/live-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Read-only operational status; starting and stopping remain server-owned. */
export async function GET() {
  return NextResponse.json(getLiveSchedulerStatus(), {
    headers: { "cache-control": "no-store" }
  });
}
