import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json({
    error: "موتور Orderbook Gap در نسخه Bitget غیرفعال است.",
    code: "ENGINE_UNAVAILABLE"
  }, { status: 410 });
}
