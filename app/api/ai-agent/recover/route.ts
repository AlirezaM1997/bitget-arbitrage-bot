import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json({
    error: "Recovery موتور AI در نسخه Bitget در دسترس نیست.",
    code: "ENGINE_UNAVAILABLE"
  }, { status: 410 });
}
