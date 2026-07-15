import { NextResponse } from "next/server";
import { z } from "zod";
import { STRATEGY_EXECUTION_STATES, listStrategyExecutions } from "@/lib/strategy-execution-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  state: z.enum(STRATEGY_EXECUTION_STATES).optional(),
  strategy: z.string().trim().min(1).max(64).optional()
}).strict();

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = querySchema.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      strategy: url.searchParams.get("strategy") ?? undefined
    });
    return NextResponse.json(await listStrategyExecutions(query));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid strategy-execution query", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read strategy execution history" }, { status: 500 });
  }
}
