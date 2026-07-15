import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotSettings } from "@/lib/bot-settings-store";
import {
  listOfflineModelArtifactIds,
  readOfflineModelArtifact,
  type OfflineModelArtifact
} from "@/lib/ai-agent/offline";
import {
  ExternalDatasetError,
  parseTardisTrainingRequest,
  trainTardisCandidate,
  type TardisCandidateTrainingResult,
  type TardisTrainingEconomics,
  type TardisTrainingRequest
} from "@/lib/ai-agent/datasets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type TrainingJob = {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  request: TardisTrainingRequest;
  artifactId?: string;
  error?: string;
};

export type AiTrainingRouteDependencies = {
  getSettings: typeof getBotSettings;
  listArtifactIds: typeof listOfflineModelArtifactIds;
  readArtifact: typeof readOfflineModelArtifact;
  trainCandidate: (
    request: TardisTrainingRequest,
    economics: TardisTrainingEconomics
  ) => Promise<TardisCandidateTrainingResult>;
  now: () => number;
  id: () => string;
};

const defaultDependencies: AiTrainingRouteDependencies = {
  getSettings: getBotSettings,
  listArtifactIds: listOfflineModelArtifactIds,
  readArtifact: readOfflineModelArtifact,
  trainCandidate: trainTardisCandidate,
  now: Date.now,
  id: randomUUID
};

let activeJob: TrainingJob | undefined;
let latestJob: TrainingJob | undefined;

export async function GET() {
  try {
    return NextResponse.json(await buildAiTrainingSnapshot());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  return handleAiTrainingPost(request);
}

export async function handleAiTrainingPost(
  request: Request,
  dependencies: AiTrainingRouteDependencies = defaultDependencies
) {
  if (!isDashboardTrainingRequest(request)) {
    return NextResponse.json({ error: "شروع آموزش فقط از داشبورد همین برنامه مجاز است" }, { status: 403 });
  }
  if (activeJob) return busyResponse();

  let parsed: TardisTrainingRequest;
  try {
    parsed = parseTardisTrainingRequest(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "درخواست دیتاست معتبر نیست", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "بدنه درخواست باید JSON معتبر باشد" }, { status: 400 });
  }

  try {
    const settings = await dependencies.getSettings();
    if (settings.aiAgent.enabled && settings.aiAgent.mode === "live") {
      return NextResponse.json({
        error: "برای آموزش Candidate ابتدا دستیار AI را از حالت Live خارج کنید",
        code: "AI_LIVE_TRAINING_BLOCKED"
      }, { status: 409 });
    }
    // Re-check after asynchronous validation/settings reads so two requests
    // cannot both pass the first in-process guard.
    if (activeJob) return busyResponse();
    const job: TrainingJob = {
      id: dependencies.id(),
      status: "running",
      startedAt: dependencies.now(),
      request: parsed
    };
    activeJob = job;
    latestJob = job;
    try {
      const result = await dependencies.trainCandidate(parsed, {
        capitalToman: settings.aiAgent.demoTradeCapitalToman,
        tomanTakerFeeBps: settings.tomanTakerFeeBps,
        slippageBps: settings.slippageBufferBps,
        depthUsagePercent: settings.aiAgent.scannerDepthUsagePercent,
        levels: settings.aiAgent.scannerLevels,
        levelWeightDecayPercent: settings.aiAgent.scannerLevelWeightDecayPercent
      });
      latestJob = {
        ...job,
        status: "completed",
        finishedAt: dependencies.now(),
        artifactId: result.artifact.artifactId
      };
      activeJob = undefined;
      const snapshot = await buildAiTrainingSnapshot(dependencies).catch(() => ({
        running: false,
        job: latestJob,
        artifacts: [result.artifact as OfflineModelArtifact],
        latestArtifact: result.artifact as OfflineModelArtifact
      }));
      return NextResponse.json({
        ...snapshot,
        artifact: result.artifact,
        latestArtifact: result.artifact,
        dataset: {
          manifest: result.dataset.manifest,
          sampleCount: result.dataset.samples.length,
          replay: result.dataset.replay
        }
      }, { status: 201 });
    } catch (error) {
      latestJob = {
        ...job,
        status: "failed",
        finishedAt: dependencies.now(),
        error: safeError(error)
      };
      activeJob = undefined;
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}

function busyResponse() {
  return NextResponse.json({
    error: "یک آموزش Candidate از قبل در حال اجراست",
    code: "AI_TRAINING_BUSY",
    running: true,
    job: activeJob
  }, { status: 409 });
}

export async function buildAiTrainingSnapshot(
  dependencies: Pick<AiTrainingRouteDependencies, "listArtifactIds" | "readArtifact"> = defaultDependencies
) {
  const ids = await dependencies.listArtifactIds();
  const artifacts: OfflineModelArtifact[] = [];
  for (const id of ids) {
    try {
      artifacts.push(await dependencies.readArtifact(id));
    } catch {
      // A corrupt artifact is intentionally omitted; readArtifact validates its
      // checksum and it can never become an implicit activation candidate here.
    }
  }
  artifacts.sort((left, right) => right.createdAt - left.createdAt || left.artifactId.localeCompare(right.artifactId));
  return {
    running: Boolean(activeJob),
    job: activeJob ?? latestJob ?? null,
    artifacts,
    latestArtifact: artifacts[0] ?? null
  };
}

function isDashboardTrainingRequest(request: Request) {
  if (request.headers.get("x-ai-training-action") !== "train-tardis-sample") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function errorResponse(error: unknown) {
  if (error instanceof ExternalDatasetError) {
    return NextResponse.json({ error: safeError(error), code: error.code }, { status: error.httpStatus });
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST" || (error instanceof Error && error.message.includes("already exists"))) {
    return NextResponse.json({ error: "این Candidate قبلاً به‌صورت تغییرناپذیر ثبت شده است", code: "ARTIFACT_EXISTS" }, { status: 409 });
  }
  return NextResponse.json({ error: safeError(error) }, { status: 500 });
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "AI Candidate training failed";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[external dataset endpoint]")
    .slice(0, 500);
}
