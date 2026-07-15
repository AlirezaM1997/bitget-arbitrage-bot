import { createHash } from "node:crypto";
import path from "node:path";
import { openNativeDatabase, type NativeDatabase } from "@/lib/db/native-sqlite";

export const EXECUTION_EVENT_TYPES = [
  "INTENT",
  "PREPARED",
  "SUBMITTING",
  "ORDER_ACKNOWLEDGED",
  "FILL",
  "RECOVERY_STARTED",
  "RECOVERY_COMPLETED",
  "COMPLETED",
  "FAILED",
  "PNL_RECORDED",
  "MANUAL_REVIEW"
] as const;

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

export type AppendExecutionEventInput = {
  executionId: string;
  engine: string;
  type: ExecutionEventType;
  idempotencyKey: string;
  occurredAt?: number;
  payload?: Record<string, unknown>;
};

export type ExecutionLedgerEvent = {
  id: number;
  executionId: string;
  engine: string;
  type: ExecutionEventType;
  idempotencyKey: string;
  occurredAt: number;
  payload: Record<string, unknown>;
  previousHash: string;
  eventHash: string;
};

type LedgerState = { db: NativeDatabase; filename: string };
type LedgerGlobal = typeof globalThis & {
  __bitgetExecutionLedgers?: Map<string, Promise<LedgerState>>;
};

function ledgerFilename() {
  const configured = process.env.EXECUTION_LEDGER_DB_PATH
    ?? (process.env.NODE_ENV === "test"
      ? ":memory:"
      : path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "execution-ledger.sqlite"));
  return configured === ":memory:" ? configured : path.resolve(/*turbopackIgnore: true*/ configured);
}

async function ledger() {
  const root = globalThis as LedgerGlobal;
  const filename = ledgerFilename();
  root.__bitgetExecutionLedgers ??= new Map();
  const existing = root.__bitgetExecutionLedgers.get(filename);
  if (existing) return existing;
  const initialized = initializeLedger(filename);
  root.__bitgetExecutionLedgers.set(filename, initialized);
  return initialized;
}

async function initializeLedger(filename: string): Promise<LedgerState> {
  const db = await openNativeDatabase(filename);
  db.run(`
    CREATE TABLE IF NOT EXISTS execution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      occurred_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_execution_events_execution
      ON execution_events(execution_id, id);
    CREATE INDEX IF NOT EXISTS idx_execution_events_occurred
      ON execution_events(occurred_at DESC, id DESC);
  `);
  return { db, filename };
}

/**
 * Appends an immutable, hash-chained audit event. Repeating an idempotency key
 * returns the original event without mutating the ledger.
 */
export async function appendExecutionEvent(input: AppendExecutionEventInput) {
  const executionId = requiredText(input.executionId, "executionId", 200);
  const engine = requiredText(input.engine, "engine", 64);
  const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 300);
  if (!EXECUTION_EVENT_TYPES.includes(input.type)) throw new Error("Unsupported execution event type");
  const occurredAt = input.occurredAt ?? Date.now();
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error("occurredAt must be a non-negative integer");
  const payloadJson = canonicalJson(input.payload ?? {});
  const { db } = await ledger();

  db.run("BEGIN IMMEDIATE");
  try {
    const duplicate = eventByIdempotencyKey(db, idempotencyKey);
    if (duplicate) {
      db.run("COMMIT");
      return { inserted: false, event: duplicate };
    }
    const previousHash = String(
      db.exec("SELECT event_hash FROM execution_events ORDER BY id DESC LIMIT 1")[0]?.values[0]?.[0] ?? "GENESIS"
    );
    const eventHash = createHash("sha256").update(canonicalJson({
      executionId,
      engine,
      type: input.type,
      idempotencyKey,
      occurredAt,
      payload: JSON.parse(payloadJson),
      previousHash
    })).digest("hex");
    db.run(`
      INSERT INTO execution_events (
        execution_id, engine, event_type, idempotency_key, occurred_at,
        payload_json, previous_hash, event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [executionId, engine, input.type, idempotencyKey, occurredAt, payloadJson, previousHash, eventHash]);
    const id = Number(db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0]);
    db.run("COMMIT");
    return {
      inserted: true,
      event: { id, executionId, engine, type: input.type, idempotencyKey, occurredAt, payload: JSON.parse(payloadJson), previousHash, eventHash }
    } satisfies { inserted: boolean; event: ExecutionLedgerEvent };
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export async function listExecutionEvents(options: { executionId?: string; limit?: number } = {}) {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 200)));
  const { db } = await ledger();
  const statement = options.executionId
    ? db.prepare("SELECT * FROM execution_events WHERE execution_id = ? ORDER BY id DESC LIMIT ?")
    : db.prepare("SELECT * FROM execution_events ORDER BY id DESC LIMIT ?");
  statement.bind(options.executionId ? [options.executionId, safeLimit] : [safeLimit]);
  const events: ExecutionLedgerEvent[] = [];
  while (statement.step()) events.push(hydrateEvent(statement.getAsObject()));
  statement.free();
  return events;
}

export async function verifyExecutionLedger() {
  const { db } = await ledger();
  const statement = db.prepare("SELECT * FROM execution_events ORDER BY id");
  statement.bind([]);
  let previousHash = "GENESIS";
  let checked = 0;
  while (statement.step()) {
    const event = hydrateEvent(statement.getAsObject());
    const expected = createHash("sha256").update(canonicalJson({
      executionId: event.executionId,
      engine: event.engine,
      type: event.type,
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt,
      payload: event.payload,
      previousHash
    })).digest("hex");
    if (event.previousHash !== previousHash || event.eventHash !== expected) {
      statement.free();
      return { valid: false, checked, invalidEventId: event.id };
    }
    previousHash = event.eventHash;
    checked += 1;
  }
  statement.free();
  return { valid: true, checked, invalidEventId: null as number | null };
}

/** Permanently clears the immutable audit ledger through the guarded admin flow. */
export async function purgeAllExecutionLedgerData() {
  const { db } = await ledger();
  const events = Number(db.exec("SELECT COUNT(*) FROM execution_events")[0]?.values[0]?.[0] ?? 0);
  db.run("BEGIN IMMEDIATE");
  try {
    db.run("DELETE FROM execution_events");
    db.run("DELETE FROM sqlite_sequence WHERE name = 'execution_events'");
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
  return { events, total: events };
}

function eventByIdempotencyKey(db: NativeDatabase, key: string) {
  const statement = db.prepare("SELECT * FROM execution_events WHERE idempotency_key = ?");
  statement.bind([key]);
  const event = statement.step() ? hydrateEvent(statement.getAsObject()) : undefined;
  statement.free();
  return event;
}

function hydrateEvent(row: Record<string, unknown>): ExecutionLedgerEvent {
  return {
    id: Number(row.id),
    executionId: String(row.execution_id),
    engine: String(row.engine),
    type: String(row.event_type) as ExecutionEventType,
    idempotencyKey: String(row.idempotency_key),
    occurredAt: Number(row.occurred_at),
    payload: JSON.parse(String(row.payload_json || "{}")),
    previousHash: String(row.previous_hash),
    eventHash: String(row.event_hash)
  };
}

function requiredText(value: string, field: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
