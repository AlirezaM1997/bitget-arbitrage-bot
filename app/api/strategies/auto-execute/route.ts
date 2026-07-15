import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request?: Request) {
  void request;
  return NextResponse.json({
    error: "اجرای خودکار استراتژی‌های قدیمی در نسخه Bitget غیرفعال است.",
    code: "ENGINE_UNAVAILABLE"
  }, { status: 410 });
}
