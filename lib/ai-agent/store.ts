import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createDefaultAiModel } from "./model";
import {
  AI_AGENT_STATE_VERSION,
  AI_FEATURE_NAMES,
  type AiAgentState,
  type AiDecision
} from "./types";

export const AI_AGENT_MAX_DECISIONS = 500;
export const AI_AGENT_MAX_RECENT_TRADES = 200;
export const AI_AGENT_MAX_OPEN_POSITIONS = 20;

type Mutation = (state: AiAgentState) => AiAgentState | void | Promise<AiAgentState | void>;
type QueueGlobal = typeof globalThis & { __bitgetAiAgentStateQueues?: Map<string, Promise<void>> };

const strategyKindSchema = z.enum(["autonomous-market", "orderbook-gap", "orderbook-imbalance"]);
const featuresSchema = z.object(Object.fromEntries(
  AI_FEATURE_NAMES.map(name => [name, z.number().finite().min(-5).max(5)])
) as Record<(typeof AI_FEATURE_NAMES)[number], z.ZodNumber>).strict();
const modelSchema = z.object({
  weights: z.object(Object.fromEntries(
    AI_FEATURE_NAMES.map(name => [name, z.number().finite().min(-8).max(8)])
  ) as Record<(typeof AI_FEATURE_NAMES)[number], z.ZodNumber>).strict(),
  bias: z.number().finite().min(-8).max(8),
  trainingSamples: z.number().int().nonnegative(),
  correctPredictions: z.number().int().nonnegative(),
  brierScoreSum: z.number().finite().nonnegative(),
  modelVersion: z.number().int().positive()
}).strict().superRefine((model, context) => {
  if (model.correctPredictions > model.trainingSamples) {
    context.addIssue({ code: "custom", path: ["correctPredictions"], message: "Correct predictions cannot exceed training samples" });
  }
});
const positionSchema = z.object({
  id: shortText(),
  kind: strategyKindSchema,
  signalId: shortText(),
  symbol: shortText(),
  openedAt: timestampSchema(),
  inputToman: z.number().finite().positive(),
  assetAmount: z.number().finite().positive(),
  entryAveragePrice: z.number().finite().positive(),
  lastMarkedOutputToman: z.number().finite().nonnegative(),
  predictionProbability: probabilitySchema(),
  features: featuresSchema,
  modelVersion: z.number().int().positive().optional(),
  learningOnly: z.boolean().optional()
}).strict();
const tradeSchema = z.object({
  id: shortText(),
  kind: strategyKindSchema,
  signalId: shortText(),
  symbol: shortText(),
  openedAt: timestampSchema(),
  closedAt: timestampSchema(),
  inputToman: z.number().finite().positive(),
  outputToman: z.number().finite().nonnegative(),
  pnlToman: z.number().finite(),
  pnlBps: z.number().finite(),
  exitReason: shortText(),
  predictionProbability: probabilitySchema(),
  features: featuresSchema,
  modelVersion: z.number().int().positive().optional(),
  learningOnly: z.boolean().optional()
}).strict().superRefine((trade, context) => {
  if (trade.closedAt < trade.openedAt) {
    context.addIssue({ code: "custom", path: ["closedAt"], message: "Trade cannot close before it opens" });
  }
});
const decisionSchema = z.object({
  id: shortText(),
  at: timestampSchema(),
  mode: z.enum(["demo", "live"]),
  action: shortText(),
  kind: strategyKindSchema.optional(),
  symbol: shortText().optional(),
  probability: probabilitySchema().optional(),
  detail: z.string().max(500).optional()
}).strict();
const stateSchema = z.object({
  version: z.literal(AI_AGENT_STATE_VERSION),
  model: modelSchema,
  demo: z.object({
    initialCapitalToman: z.number().finite().positive(),
    cashToman: z.number().finite().nonnegative(),
    realizedPnlToman: z.number().finite(),
    peakEquityToman: z.number().finite().nonnegative(),
    maxDrawdownToman: z.number().finite().nonnegative(),
    lastEntryAt: timestampSchema().nullable(),
    openPositions: z.array(positionSchema).max(AI_AGENT_MAX_OPEN_POSITIONS),
    recentTrades: z.array(tradeSchema).max(AI_AGENT_MAX_RECENT_TRADES)
  }).strict(),
  decisions: z.array(decisionSchema).max(AI_AGENT_MAX_DECISIONS),
  updatedAt: timestampSchema()
}).strict();

export function aiAgentStatePath() {
  return process.env.AI_AGENT_STATE_PATH?.trim()
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "ai-agent-state.json");
}

export function createDefaultAiAgentState(capital: number, now = Date.now()): AiAgentState {
  const initialCapitalToman = validCapital(capital);
  const updatedAt = validTimestamp(now);
  return {
    version: AI_AGENT_STATE_VERSION,
    model: createDefaultAiModel(),
    demo: {
      initialCapitalToman,
      cashToman: initialCapitalToman,
      realizedPnlToman: 0,
      peakEquityToman: initialCapitalToman,
      maxDrawdownToman: 0,
      lastEntryAt: null,
      openPositions: [],
      recentTrades: []
    },
    decisions: [],
    updatedAt
  };
}

export async function readAiAgentState(capital: number) {
  const filename = aiAgentStatePath();
  return enqueue(filename, async () => clone(await readUnlocked(filename, capital)));
}

export async function mutateAiAgentState(capital: number, mutator: Mutation) {
  const filename = aiAgentStatePath();
  return enqueue(filename, async () => {
    const current = await readUnlocked(filename, capital);
    const draft = clone(current);
    const returned = await mutator(draft);
    const next = migrateAiAgentState(returned ?? draft, capital);
    next.updatedAt = Date.now();
    const validated = stateSchema.parse(next);
    await writeAtomic(filename, validated);
    return clone(validated);
  });
}

export async function resetAiAgentState(capital: number) {
  const filename = aiAgentStatePath();
  return enqueue(filename, async () => {
    const state = createDefaultAiAgentState(capital);
    await writeAtomic(filename, state);
    return clone(state);
  });
}

/** Pure bounded append helper; persistence remains an explicit mutation. */
export function appendAiDecision(state: AiAgentState, decision: AiDecision): AiAgentState {
  const parsed = decisionSchema.parse(decision) as AiDecision;
  state.decisions.push(parsed);
  if (state.decisions.length > AI_AGENT_MAX_DECISIONS) {
    state.decisions.splice(0, state.decisions.length - AI_AGENT_MAX_DECISIONS);
  }
  state.updatedAt = Math.max(state.updatedAt, parsed.at);
  return state;
}

export function migrateAiAgentState(input: unknown, capital: number): AiAgentState {
  if (!isRecord(input)) throw new Error("AI agent state must be an object");
  if (input.version !== undefined && input.version !== AI_AGENT_STATE_VERSION) {
    throw new Error(`Unsupported AI agent state version: ${String(input.version)}`);
  }
  const defaults = createDefaultAiAgentState(capital);
  const rawModel = isRecord(input.model) ? input.model : {};
  const rawWeights = isRecord(rawModel.weights) ? rawModel.weights : {};
  const rawDemo = isRecord(input.demo) ? input.demo : {};
  const initialCapitalToman = positiveNumber(rawDemo.initialCapitalToman) ?? defaults.demo.initialCapitalToman;
  const candidate = {
    version: AI_AGENT_STATE_VERSION,
    model: {
      weights: Object.fromEntries(AI_FEATURE_NAMES.map(name => [name, finiteNumber(rawWeights[name]) ?? 0])),
      bias: finiteNumber(rawModel.bias) ?? 0,
      trainingSamples: nonNegativeInteger(rawModel.trainingSamples) ?? 0,
      correctPredictions: nonNegativeInteger(rawModel.correctPredictions) ?? 0,
      brierScoreSum: nonNegativeNumber(rawModel.brierScoreSum) ?? 0,
      modelVersion: positiveInteger(rawModel.modelVersion) ?? 1
    },
    demo: {
      initialCapitalToman,
      cashToman: nonNegativeNumber(rawDemo.cashToman) ?? initialCapitalToman,
      realizedPnlToman: finiteNumber(rawDemo.realizedPnlToman) ?? 0,
      peakEquityToman: nonNegativeNumber(rawDemo.peakEquityToman) ?? initialCapitalToman,
      maxDrawdownToman: nonNegativeNumber(rawDemo.maxDrawdownToman) ?? 0,
      lastEntryAt: rawDemo.lastEntryAt === null ? null : nonNegativeInteger(rawDemo.lastEntryAt) ?? null,
      openPositions: boundedArray(rawDemo.openPositions, AI_AGENT_MAX_OPEN_POSITIONS),
      recentTrades: boundedArray(rawDemo.recentTrades, AI_AGENT_MAX_RECENT_TRADES)
    },
    decisions: boundedArray(input.decisions, AI_AGENT_MAX_DECISIONS),
    updatedAt: nonNegativeInteger(input.updatedAt) ?? defaults.updatedAt
  };
  try {
    return stateSchema.parse(candidate) as AiAgentState;
  } catch (error) {
    throw new Error(`Invalid AI agent state: ${error instanceof Error ? error.message : "schema validation failed"}`, { cause: error });
  }
}

async function readUnlocked(filename: string, capital: number) {
  try {
    const parsed = JSON.parse(await readFile(/*turbopackIgnore: true*/ filename, "utf8"));
    return migrateAiAgentState(parsed, capital);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error(`Invalid AI agent state JSON: ${error.message}`, { cause: error });
      throw error;
    }
    const state = createDefaultAiAgentState(capital);
    await writeAtomic(filename, state);
    return state;
  }
}

async function writeAtomic(filename: string, state: AiAgentState) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function enqueue<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const root = globalThis as QueueGlobal;
  root.__bitgetAiAgentStateQueues ??= new Map();
  const previous = root.__bitgetAiAgentStateQueues.get(filename) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tracked = run.then(() => undefined, () => undefined);
  root.__bitgetAiAgentStateQueues.set(filename, tracked);
  return run.finally(() => {
    if (root.__bitgetAiAgentStateQueues?.get(filename) === tracked) {
      root.__bitgetAiAgentStateQueues.delete(filename);
    }
  });
}

function shortText() {
  return z.string().trim().min(1).max(200);
}

function timestampSchema() {
  return z.number().int().nonnegative().safe();
}

function probabilitySchema() {
  return z.number().finite().min(0).max(1);
}

function validCapital(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("AI Demo capital must be a positive finite number");
  return value;
}

function validTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("AI agent timestamp must be a non-negative safe integer");
  return value;
}

function boundedArray(value: unknown, maximum: number) {
  return Array.isArray(value) ? value.slice(-maximum) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value: unknown) {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function nonNegativeNumber(value: unknown) {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
