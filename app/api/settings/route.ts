import { NextResponse } from "next/server";
import { botSettingsSchema, type BotSettings } from "@/lib/bot-settings";
import { getBotSettings, saveBotSettings } from "@/lib/bot-settings-store";
import { getRiskControlSnapshot } from "@/lib/risk/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getBotSettings());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در خواندن تنظیمات" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!isDashboardSettingsRequest(request)) {
    return NextResponse.json({ error: "تغییر تنظیمات فقط از داشبورد همین برنامه مجاز است" }, { status: 403 });
  }
  try {
    const current = await getBotSettings();
    const next = botSettingsSchema.parse(await request.json());
    if (bitgetConnectionSettingsChanged(current, next)) {
      const risk = await getRiskControlSnapshot();
      if (risk.state.masterArmed || risk.activeLeases.length > 0) {
        return NextResponse.json({
          error: "برای تغییر نوع حساب یا محیط Bitget ابتدا Master Live را خاموش کنید و منتظر پایان معامله یا بازیابی در حال اجرا بمانید.",
          code: "BITGET_CONNECTION_SETTINGS_LOCKED"
        }, { status: 409 });
      }
    }
    return NextResponse.json(await saveBotSettings(next));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در ذخیره تنظیمات" }, { status: 400 });
  }
}

export function bitgetConnectionSettingsChanged(
  current: Pick<BotSettings, "bitgetAccountMode" | "bitgetDemoTrading">,
  next: Pick<BotSettings, "bitgetAccountMode" | "bitgetDemoTrading">
) {
  return current.bitgetAccountMode !== next.bitgetAccountMode
    || current.bitgetDemoTrading !== next.bitgetDemoTrading;
}

export function isDashboardSettingsRequest(request: Request) {
  if (request.headers.get("x-settings-action") !== "bitget-dashboard") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
