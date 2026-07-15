import { NextResponse } from "next/server";
import { getBotSettings } from "@/lib/bot-settings-store";
import { bitgetClientSettings } from "@/lib/bitget-runtime-settings";
import { BitgetClient } from "@/lib/exchanges/bitget";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getBotSettings();
    const portfolio = await new BitgetClient(bitgetClientSettings(settings)).getSpotPortfolioSummary();
    return NextResponse.json({
      // Response keys stay stable for the inherited dashboard contract; every
      // value is native USDT and no rial/toman scale is applied.
      spotTotalToman: portfolio.totalEstimatedUsdt.toString(),
      availableToman: portfolio.availableUsdt.toString(),
      blockedToman: portfolio.blockedUsdt.toString(),
      unpricedAssets: portfolio.unpricedAssets.map(item => ({
        asset: item.asset,
        amount: item.amount.toString()
      })),
      fetchedAt: Date.now()
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در دریافت موجودی" }, { status: 400 });
  }
}
