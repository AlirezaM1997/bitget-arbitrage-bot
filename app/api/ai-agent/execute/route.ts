import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json({
    error: "موتور AI در نسخه Bitget غیرفعال است؛ فقط آربیتراژ مثلثی قابل اجراست.",
    code: "ENGINE_UNAVAILABLE"
  }, { status: 410 });
}
