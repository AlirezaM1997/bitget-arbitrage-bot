import { NextResponse } from "next/server";
import Decimal from "decimal.js";
import { botSettingsSchema } from "@/lib/bot-settings";
import type { BotSettings } from "@/lib/bot-settings";
import { bitgetClientSettings } from "@/lib/bitget-runtime-settings";
import { liveCapital, scan } from "@/lib/bot/scanner";
import { BitgetClient } from "@/lib/exchanges/bitget";
import { serializeOpportunity } from "@/lib/serializers";
import { saveProfitableOpportunities } from "@/lib/opportunity-store";
import { liveSafetyRejectionReason } from "@/lib/bot/executor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const inputSchema = botSettingsSchema;
const LIVE_CAPITAL_CACHE_MS = 5_000;
let liveCapitalCache: { key: string; value: Awaited<ReturnType<typeof liveCapital>>; expiresAt: number } | undefined;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست اسکن JSON معتبر نیست" }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(" | ");
    return NextResponse.json({ error: `تنظیمات اسکن نامعتبر است: ${details}` }, { status: 400 });
  }

  try {
    const settings = parsed.data;
    const mode = scanModeFromHeader(request.headers.get("x-bot-mode"));
    const client = new BitgetClient(bitgetClientSettings(settings));
    const capital = mode === "live" ? await liveScanCapital(settings, client) : new Decimal(settings.paperCapitalToman);
    if (mode === "live" && capital.lte(0)) throw new Error("موجودی آزاد USDT برای اسکن واقعی کافی نیست");
    const result = await scan(capital, settings, client);
    if (mode === "live") {
      for (const opportunity of result.opportunities) {
        if (!opportunity.executable) continue;
        const rejection = liveSafetyRejectionReason(opportunity, settings);
        if (rejection) {
          opportunity.executable = false;
          opportunity.rejectionReason = rejection;
        }
      }
      result.executableCount = result.opportunities.filter(item => item.executable).length;
    }
    // Keep the existing database enum compatible while exposing the clearer
    // Demo/Real contract to the dashboard.
    const profitableSaved = await saveProfitableOpportunities(
      result.opportunities,
      mode === "live" ? "live" : "paper",
      settings
    );
    return NextResponse.json({ mode, scannedAt: result.scannedAt, capitalToman: result.capitalToman.toString(),
      exchangeMarketCount: result.exchangeMarketCount, relevantMarketCount: result.relevantMarketCount, marketCount: result.marketCount,
      depthRefinedMarketCount: result.depthRefinedMarketCount,
      triangleCount: result.triangleCount, evaluatedSizeCount: result.evaluatedSizeCount,
      promisingPathCount: result.promisingPathCount, fastRejectedPathCount: result.fastRejectedPathCount,
      refinedPathCount: result.refinedPathCount, positiveCount: result.positiveCount,
      liquiditySafePositiveCount: result.liquiditySafePositiveCount, engineMs: result.engineMs,
      executableCount: result.executableCount, profitableSaved, opportunities: result.opportunities.slice(0, 100).map(serializeOpportunity) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطای ناشناخته در اسکن بازار" }, { status: 502 });
  }
}

export function scanModeFromHeader(value: string | null): "demo" | "live" {
  return value === "live" ? "live" : "demo";
}

async function liveScanCapital(settings: BotSettings, client: BitgetClient) {
  const key = `${settings.maxTradeToman}:${settings.balanceUsagePercent}`;
  if (liveCapitalCache && liveCapitalCache.key === key && liveCapitalCache.expiresAt > Date.now()) return liveCapitalCache.value;
  const value = await liveCapital(settings, client);
  liveCapitalCache = { key, value, expiresAt: Date.now() + LIVE_CAPITAL_CACHE_MS };
  return value;
}
