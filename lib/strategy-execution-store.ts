import path from "node:path";
import { openNativeDatabase, type NativeDatabase } from "@/lib/db/native-sqlite";

export const STRATEGY_EXECUTION_STATES = [
  "DETECTED",
  "REVALIDATING",
  "SUBMITTING",
  "PARTIALLY_FILLED",
  "HEDGING",
  "RECOVERING",
  "CLOSED",
  "FAILED_MANUAL"
] as const;

export type StrategyExecutionState = (typeof STRATEGY_EXECUTION_STATES)[number];
export type StrategyOrderSide = "BUY" | "SELL";

export type CreateStrategyExecutionInput = {
  strategy: string;
  signalId?: string | null;
  symbols: string[];
  direction: string;
  requestedCapitalToman?: number | null;
  plannedProfitToman?: number | null;
  metadata?: Record<string, unknown>;
  detectedAt?: number;
};

export type StrategyTransitionInput = {
  at?: number;
  note?: string | null;
  metadata?: Record<string, unknown>;
};

export type AddStrategyOrderInput = {
  legIndex: number;
  symbol: string;
  side: StrategyOrderSide;
  orderType?: string;
  status: string;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
  requestedAmount?: string | number | null;
  filledAmount?: string | number | null;
  averagePrice?: string | number | null;
  fee?: string | number | null;
  inputAsset?: string | null;
  outputAsset?: string | null;
  raw?: unknown;
  createdAt?: number;
};

export type CompleteStrategyExecutionInput = StrategyTransitionInput & {
  actualOutputToman?: number | null;
  actualProfitToman?: number | null;
};

export type StrategyExecutionOrder = {
  id: number;
  executionId: number;
  legIndex: number;
  symbol: string;
  side: StrategyOrderSide;
  orderType: string;
  status: string;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  requestedAmount: string | null;
  filledAmount: string | null;
  averagePrice: string | null;
  fee: string | null;
  inputAsset: string | null;
  outputAsset: string | null;
  raw: unknown;
  createdAt: number;
};

export type StrategyExecutionTransition = {
  id: number;
  executionId: number;
  fromState: StrategyExecutionState | null;
  toState: StrategyExecutionState;
  transitionedAt: number;
  note: string | null;
  metadata: Record<string, unknown>;
};

export type StrategyExecutionRecord = {
  id: number;
  strategy: string;
  signalId: string | null;
  state: StrategyExecutionState;
  symbols: string[];
  direction: string;
  detectedAt: number;
  updatedAt: number;
  closedAt: number | null;
  requestedCapitalToman: number | null;
  plannedProfitToman: number | null;
  actualOutputToman: number | null;
  actualProfitToman: number | null;
  error: string | null;
  metadata: Record<string, unknown>;
  orders: StrategyExecutionOrder[];
  transitions: StrategyExecutionTransition[];
};

export type StrategyExecutionListOptions = {
  limit?: number;
  state?: StrategyExecutionState;
  strategy?: string;
};

export type RecentStrategyExecutionQuery = {
  strategy: string;
  signalId: string;
  since: number;
};

export type StrategyExecutionSummary = {
  totalCount: number;
  activeCount: number;
  closedCount: number;
  failedManualCount: number;
  partiallyFilledCount: number;
  totalActualProfitToman: number;
  byState: Record<StrategyExecutionState, number>;
};

type DbState = { db: NativeDatabase; filename: string };
type DbGlobal = typeof globalThis & { __bitgetStrategyExecutionDbs?: Map<string, Promise<DbState>> };

export class StrategyExecutionConflictError extends Error {
  readonly code = "EXECUTION_ALREADY_ACTIVE";
  constructor(readonly existingExecutionId: number) {
    super(`An active execution already owns this strategy signal (execution ${existingExecutionId})`);
    this.name = "StrategyExecutionConflictError";
  }
}

const transitions: Record<StrategyExecutionState, ReadonlySet<StrategyExecutionState>> = {
  DETECTED: new Set(["REVALIDATING", "FAILED_MANUAL"]),
  REVALIDATING: new Set(["SUBMITTING", "FAILED_MANUAL"]),
  SUBMITTING: new Set(["PARTIALLY_FILLED", "HEDGING", "RECOVERING", "CLOSED", "FAILED_MANUAL"]),
  PARTIALLY_FILLED: new Set(["HEDGING", "RECOVERING", "CLOSED", "FAILED_MANUAL"]),
  HEDGING: new Set(["RECOVERING", "CLOSED", "FAILED_MANUAL"]),
  RECOVERING: new Set(["HEDGING", "CLOSED", "FAILED_MANUAL"]),
  CLOSED: new Set(),
  FAILED_MANUAL: new Set()
};

const orderAcceptingStates = new Set<StrategyExecutionState>([
  "SUBMITTING", "PARTIALLY_FILLED", "HEDGING", "RECOVERING"
]);

async function database() {
  const globalDb = globalThis as DbGlobal;
  const filename = strategyExecutionDatabaseFilename();
  globalDb.__bitgetStrategyExecutionDbs ??= new Map();
  const existing = globalDb.__bitgetStrategyExecutionDbs.get(filename);
  if (existing) return existing;
  const initialized = initializeDatabase(filename);
  globalDb.__bitgetStrategyExecutionDbs.set(filename, initialized);
  return initialized;
}

function strategyExecutionDatabaseFilename() {
  const configured = process.env.STRATEGY_EXECUTION_DB_PATH
    ?? (process.env.NODE_ENV === "test"
      ? ":memory:"
      : path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "strategy-executions.sqlite"));
  return configured === ":memory:" ? configured : path.resolve(/*turbopackIgnore: true*/ configured);
}

async function initializeDatabase(filename: string): Promise<DbState> {
  const db = await openNativeDatabase(filename);

  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS strategy_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      signal_id TEXT,
      state TEXT NOT NULL CHECK(state IN (${STRATEGY_EXECUTION_STATES.map(state => `'${state}'`).join(", ")})),
      symbols_json TEXT NOT NULL,
      direction TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      requested_capital_toman REAL,
      planned_profit_toman REAL,
      actual_output_toman REAL,
      actual_profit_toman REAL,
      error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      hidden_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_executions_updated ON strategy_executions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_strategy_executions_state ON strategy_executions(state);
    CREATE INDEX IF NOT EXISTS idx_strategy_executions_strategy ON strategy_executions(strategy);

    CREATE TABLE IF NOT EXISTS strategy_execution_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER NOT NULL REFERENCES strategy_executions(id) ON DELETE CASCADE,
      from_state TEXT,
      to_state TEXT NOT NULL,
      transitioned_at INTEGER NOT NULL,
      note TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_transitions_execution ON strategy_execution_transitions(execution_id, id);

    CREATE TABLE IF NOT EXISTS strategy_execution_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER NOT NULL REFERENCES strategy_executions(id) ON DELETE CASCADE,
      leg_index INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
      order_type TEXT NOT NULL,
      status TEXT NOT NULL,
      client_order_id TEXT,
      exchange_order_id TEXT,
      requested_amount TEXT,
      filled_amount TEXT,
      average_price TEXT,
      fee TEXT,
      input_asset TEXT,
      output_asset TEXT,
      raw_json TEXT NOT NULL DEFAULT 'null',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_orders_execution ON strategy_execution_orders(execution_id, leg_index, id);
  `);
  const executionColumns = new Set(
    (db.exec("PRAGMA table_info(strategy_executions)")[0]?.values ?? []).map(row => String(row[1]))
  );
  if (!executionColumns.has("hidden_at")) {
    db.run("ALTER TABLE strategy_executions ADD COLUMN hidden_at INTEGER");
  }
  return { db, filename };
}

function persist(state: DbState) {
  void state;
}

function requiredText(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function finiteNumber(value: number | null | undefined, name: string) {
  if (value == null) return null;
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function timestamp(value: number | undefined) {
  const result = value ?? Date.now();
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("timestamp must be a non-negative safe integer");
  return result;
}

function stringifyJson(value: unknown, fallback: unknown) {
  const serialized = JSON.stringify(value ?? fallback);
  if (serialized === undefined) throw new Error("value is not JSON serializable");
  return serialized;
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function lastInsertId(db: NativeDatabase) {
  return Number(db.exec("SELECT last_insert_rowid() AS id")[0]?.values[0]?.[0]);
}

function currentState(db: NativeDatabase, id: number): StrategyExecutionState {
  const statement = db.prepare("SELECT state FROM strategy_executions WHERE id = ?");
  statement.bind([id]);
  const exists = statement.step();
  const state = exists ? String(statement.get()[0]) as StrategyExecutionState : undefined;
  statement.free();
  if (!state) throw new Error(`Strategy execution ${id} was not found`);
  return state;
}

export function canTransitionStrategyExecution(from: StrategyExecutionState, to: StrategyExecutionState) {
  return transitions[from].has(to);
}

export async function createStrategyExecution(input: CreateStrategyExecutionInput) {
  const state = await database();
  const at = timestamp(input.detectedAt);
  const strategy = requiredText(input.strategy, "strategy");
  const direction = requiredText(input.direction, "direction");
  const symbols = [...new Set(input.symbols.map(symbol => requiredText(symbol, "symbol")))];
  if (!symbols.length) throw new Error("At least one symbol is required");
  const metadata = stringifyJson(input.metadata, {});

  state.db.run("BEGIN");
  try {
    if (input.signalId?.trim()) {
      const duplicate = state.db.prepare(`
        SELECT id FROM strategy_executions
        WHERE strategy = ? AND signal_id = ? AND state NOT IN ('CLOSED', 'FAILED_MANUAL')
        ORDER BY id DESC LIMIT 1
      `);
      duplicate.bind([strategy, input.signalId.trim()]);
      const existingId = duplicate.step() ? Number(duplicate.get()[0]) : undefined;
      duplicate.free();
      if (existingId) throw new StrategyExecutionConflictError(existingId);
    }
    state.db.run(`
      INSERT INTO strategy_executions (
        strategy, signal_id, state, symbols_json, direction, detected_at, updated_at,
        requested_capital_toman, planned_profit_toman, metadata_json
      ) VALUES (?, ?, 'DETECTED', ?, ?, ?, ?, ?, ?, ?)
    `, [
      strategy,
      input.signalId ?? null,
      stringifyJson(symbols, []),
      direction,
      at,
      at,
      finiteNumber(input.requestedCapitalToman, "requestedCapitalToman"),
      finiteNumber(input.plannedProfitToman, "plannedProfitToman"),
      metadata
    ]);
    const id = lastInsertId(state.db);
    state.db.run(`
      INSERT INTO strategy_execution_transitions (
        execution_id, from_state, to_state, transitioned_at, note, metadata_json
      ) VALUES (?, NULL, 'DETECTED', ?, ?, ?)
    `, [id, at, "Execution detected", metadata]);
    state.db.run("COMMIT");
    persist(state);
    return getStrategyExecution(id);
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
}

export async function transitionStrategyExecution(
  id: number,
  to: StrategyExecutionState,
  input: StrategyTransitionInput = {}
) {
  const state = await database();
  const from = currentState(state.db, id);
  if (!canTransitionStrategyExecution(from, to)) {
    throw new Error(`Invalid strategy execution transition: ${from} -> ${to}`);
  }
  const at = timestamp(input.at);
  const eventMetadata = stringifyJson(input.metadata, {});

  state.db.run("BEGIN");
  try {
    const currentMetadataStatement = state.db.prepare("SELECT metadata_json FROM strategy_executions WHERE id = ?");
    currentMetadataStatement.bind([id]);
    currentMetadataStatement.step();
    const mergedMetadata = { ...parseObject(currentMetadataStatement.get()[0]), ...(input.metadata ?? {}) };
    currentMetadataStatement.free();
    state.db.run(
      "UPDATE strategy_executions SET state = ?, updated_at = ?, metadata_json = ? WHERE id = ?",
      [to, at, stringifyJson(mergedMetadata, {}), id]
    );
    state.db.run(`
      INSERT INTO strategy_execution_transitions (
        execution_id, from_state, to_state, transitioned_at, note, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [id, from, to, at, input.note ?? null, eventMetadata]);
    state.db.run("COMMIT");
    persist(state);
    return getStrategyExecution(id);
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
}

export async function addStrategyExecutionOrder(id: number, input: AddStrategyOrderInput) {
  const state = await database();
  const executionState = currentState(state.db, id);
  if (!orderAcceptingStates.has(executionState)) {
    throw new Error(`Cannot add an order while execution ${id} is ${executionState}`);
  }
  if (!Number.isSafeInteger(input.legIndex) || input.legIndex < 0) throw new Error("legIndex must be a non-negative integer");
  const at = timestamp(input.createdAt);
  state.db.run(`
    INSERT INTO strategy_execution_orders (
      execution_id, leg_index, symbol, side, order_type, status, client_order_id,
      exchange_order_id, requested_amount, filled_amount, average_price, fee,
      input_asset, output_asset, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    input.legIndex,
    requiredText(input.symbol, "symbol"),
    input.side,
    requiredText(input.orderType ?? "MARKET", "orderType"),
    requiredText(input.status, "status"),
    input.clientOrderId ?? null,
    input.exchangeOrderId ?? null,
    input.requestedAmount == null ? null : String(input.requestedAmount),
    input.filledAmount == null ? null : String(input.filledAmount),
    input.averagePrice == null ? null : String(input.averagePrice),
    input.fee == null ? null : String(input.fee),
    input.inputAsset ?? null,
    input.outputAsset ?? null,
    stringifyJson(input.raw, null),
    at
  ]);
  const orderId = lastInsertId(state.db);
  state.db.run("UPDATE strategy_executions SET updated_at = ? WHERE id = ?", [at, id]);
  persist(state);
  return (await getStrategyExecution(id)).orders.find(order => order.id === orderId)!;
}

export async function completeStrategyExecution(id: number, input: CompleteStrategyExecutionInput = {}) {
  const record = await transitionStrategyExecution(id, "CLOSED", input);
  const state = await database();
  state.db.run(`
    UPDATE strategy_executions SET closed_at = ?, actual_output_toman = ?, actual_profit_toman = ?, error = NULL
    WHERE id = ?
  `, [
    record.updatedAt,
    finiteNumber(input.actualOutputToman, "actualOutputToman"),
    finiteNumber(input.actualProfitToman, "actualProfitToman"),
    id
  ]);
  persist(state);
  return getStrategyExecution(id);
}

export async function failStrategyExecution(
  id: number,
  error: string,
  input: StrategyTransitionInput = {}
) {
  const message = requiredText(error, "error");
  const record = await transitionStrategyExecution(id, "FAILED_MANUAL", { ...input, note: input.note ?? message });
  const state = await database();
  state.db.run(
    "UPDATE strategy_executions SET closed_at = ?, error = ? WHERE id = ?",
    [record.updatedAt, message, id]
  );
  persist(state);
  return getStrategyExecution(id);
}

export async function getStrategyExecution(id: number): Promise<StrategyExecutionRecord> {
  const { db } = await database();
  const statement = db.prepare("SELECT * FROM strategy_executions WHERE id = ?");
  statement.bind([id]);
  if (!statement.step()) {
    statement.free();
    throw new Error(`Strategy execution ${id} was not found`);
  }
  const row = statement.getAsObject();
  statement.free();
  return hydrateExecution(db, row);
}

export async function listStrategyExecutions(options: StrategyExecutionListOptions = {}) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const stateClauses: string[] = ["hidden_at IS NULL"];
  const params: Array<string | number> = [];
  if (options.state) {
    stateClauses.push("state = ?");
    params.push(options.state);
  }
  if (options.strategy?.trim()) {
    stateClauses.push("strategy = ?");
    params.push(options.strategy.trim());
  }
  const where = `WHERE ${stateClauses.join(" AND ")}`;
  const { db } = await database();
  const statement = db.prepare(`SELECT * FROM strategy_executions ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`);
  statement.bind([...params, safeLimit]);
  const rows: Array<Record<string, unknown>> = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return {
    summary: summarize(db),
    records: rows.map(row => hydrateExecution(db, row))
  };
}

/**
 * Server-side idempotency/cooldown lookup used before automatic execution.
 * Active records always match, even when they started before the cooldown
 * window; terminal attempts match while their detection time is recent.
 */
export async function findRecentStrategyExecution(input: RecentStrategyExecutionQuery) {
  const strategy = requiredText(input.strategy, "strategy");
  const signalId = requiredText(input.signalId, "signalId");
  const since = timestamp(input.since);
  const { db } = await database();
  const statement = db.prepare(`
    SELECT * FROM strategy_executions
    WHERE strategy = ? AND signal_id = ?
      AND (state NOT IN ('CLOSED', 'FAILED_MANUAL') OR COALESCE(closed_at, updated_at) >= ?)
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `);
  statement.bind([strategy, signalId, since]);
  const row = statement.step() ? statement.getAsObject() : undefined;
  statement.free();
  return row ? hydrateExecution(db, row) : undefined;
}

export async function clearStrategyExecutionStore() {
  const state = await database();
  if (process.env.NODE_ENV !== "test" && state.filename !== ":memory:") {
    throw new Error("Hard deletion of the execution audit ledger is disabled outside tests");
  }
  const count = Number(state.db.exec("SELECT COUNT(*) FROM strategy_executions")[0]?.values[0]?.[0] ?? 0);
  state.db.run("BEGIN");
  try {
    state.db.run("DELETE FROM strategy_execution_orders");
    state.db.run("DELETE FROM strategy_execution_transitions");
    state.db.run("DELETE FROM strategy_executions");
    state.db.run("DELETE FROM sqlite_sequence WHERE name IN ('strategy_execution_orders', 'strategy_execution_transitions', 'strategy_executions')");
    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
  persist(state);
  return count;
}

/**
 * Hard-deletes the complete strategy execution database. Production callers
 * must use the guarded administrative route; normal history cleanup archives.
 */
export async function purgeAllStrategyExecutionData() {
  const state = await database();
  const executions = Number(state.db.exec("SELECT COUNT(*) FROM strategy_executions")[0]?.values[0]?.[0] ?? 0);
  const orders = Number(state.db.exec("SELECT COUNT(*) FROM strategy_execution_orders")[0]?.values[0]?.[0] ?? 0);
  const transitions = Number(state.db.exec("SELECT COUNT(*) FROM strategy_execution_transitions")[0]?.values[0]?.[0] ?? 0);
  state.db.run("BEGIN IMMEDIATE");
  try {
    state.db.run("DELETE FROM strategy_execution_orders");
    state.db.run("DELETE FROM strategy_execution_transitions");
    state.db.run("DELETE FROM strategy_executions");
    state.db.run("DELETE FROM sqlite_sequence WHERE name IN ('strategy_execution_orders', 'strategy_execution_transitions', 'strategy_executions')");
    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
  persist(state);
  return { executions, orders, transitions, total: executions + orders + transitions };
}

/** Includes hidden records and manual failures that still contain order evidence. */
export async function countUnsafeStrategyExecutionRecords() {
  const { db } = await database();
  return Number(db.exec(`
    SELECT COUNT(*) FROM strategy_executions execution
    WHERE execution.state NOT IN ('CLOSED', 'FAILED_MANUAL')
      OR (
        execution.state = 'FAILED_MANUAL'
        AND EXISTS (
          SELECT 1 FROM strategy_execution_orders orders
          WHERE orders.execution_id = execution.id
        )
      )
  `)[0]?.values[0]?.[0] ?? 0);
}

/**
 * Archives rows that are safe to hide from the dashboard. Orders, transitions
 * and financially-final records stay immutable in SQLite for reconciliation.
 */
export async function clearDashboardStrategyExecutionHistory(
  staleBefore = Date.now() - 5 * 60_000
) {
  const state = await database();
  const clearable = state.db.prepare(`
    SELECT execution.id
    FROM strategy_executions execution
    WHERE execution.hidden_at IS NULL
      AND (
      execution.state = 'CLOSED'
      OR (
        NOT EXISTS (
          SELECT 1 FROM strategy_execution_orders orders
          WHERE orders.execution_id = execution.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM strategy_execution_transitions transition_log
          WHERE transition_log.execution_id = execution.id
            AND transition_log.to_state IN ('SUBMITTING', 'PARTIALLY_FILLED', 'HEDGING', 'RECOVERING')
        )
        AND (
          execution.state = 'FAILED_MANUAL'
          OR (execution.state IN ('DETECTED', 'REVALIDATING') AND execution.updated_at <= ?)
        )
      )
    )
  `);
  clearable.bind([staleBefore]);
  const ids: number[] = [];
  while (clearable.step()) ids.push(Number(clearable.get()[0]));
  clearable.free();
  if (!ids.length) return 0;

  const placeholders = ids.map(() => "?").join(", ");
  state.db.run("BEGIN");
  try {
    state.db.run(`UPDATE strategy_executions SET hidden_at = ? WHERE id IN (${placeholders})`, [Date.now(), ...ids]);
    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
  persist(state);
  return ids.length;
}

function summarize(db: NativeDatabase): StrategyExecutionSummary {
  const byState = Object.fromEntries(STRATEGY_EXECUTION_STATES.map(state => [state, 0])) as Record<StrategyExecutionState, number>;
  const stateRows = db.exec("SELECT state, COUNT(*) FROM strategy_executions WHERE hidden_at IS NULL GROUP BY state")[0]?.values ?? [];
  for (const [state, count] of stateRows) byState[String(state) as StrategyExecutionState] = Number(count);
  const totalActualProfitToman = Number(db.exec(
    "SELECT COALESCE(SUM(actual_profit_toman), 0) FROM strategy_executions WHERE state = 'CLOSED' AND hidden_at IS NULL"
  )[0]?.values[0]?.[0] ?? 0);
  const totalCount = Object.values(byState).reduce((total, count) => total + count, 0);
  return {
    totalCount,
    activeCount: totalCount - byState.CLOSED - byState.FAILED_MANUAL,
    closedCount: byState.CLOSED,
    failedManualCount: byState.FAILED_MANUAL,
    partiallyFilledCount: byState.PARTIALLY_FILLED,
    totalActualProfitToman,
    byState
  };
}

function hydrateExecution(db: NativeDatabase, row: Record<string, unknown>): StrategyExecutionRecord {
  const id = Number(row.id);
  const orderStatement = db.prepare("SELECT * FROM strategy_execution_orders WHERE execution_id = ? ORDER BY leg_index, id");
  orderStatement.bind([id]);
  const orders: StrategyExecutionOrder[] = [];
  while (orderStatement.step()) {
    const order = orderStatement.getAsObject();
    let raw: unknown = null;
    try { raw = JSON.parse(String(order.raw_json ?? "null")); } catch { raw = null; }
    orders.push({
      id: Number(order.id), executionId: id, legIndex: Number(order.leg_index), symbol: String(order.symbol),
      side: String(order.side) as StrategyOrderSide, orderType: String(order.order_type), status: String(order.status),
      clientOrderId: order.client_order_id == null ? null : String(order.client_order_id),
      exchangeOrderId: order.exchange_order_id == null ? null : String(order.exchange_order_id),
      requestedAmount: order.requested_amount == null ? null : String(order.requested_amount),
      filledAmount: order.filled_amount == null ? null : String(order.filled_amount),
      averagePrice: order.average_price == null ? null : String(order.average_price),
      fee: order.fee == null ? null : String(order.fee), inputAsset: order.input_asset == null ? null : String(order.input_asset),
      outputAsset: order.output_asset == null ? null : String(order.output_asset), raw, createdAt: Number(order.created_at)
    });
  }
  orderStatement.free();

  const transitionStatement = db.prepare("SELECT * FROM strategy_execution_transitions WHERE execution_id = ? ORDER BY id");
  transitionStatement.bind([id]);
  const executionTransitions: StrategyExecutionTransition[] = [];
  while (transitionStatement.step()) {
    const item = transitionStatement.getAsObject();
    executionTransitions.push({
      id: Number(item.id), executionId: id,
      fromState: item.from_state == null ? null : String(item.from_state) as StrategyExecutionState,
      toState: String(item.to_state) as StrategyExecutionState, transitionedAt: Number(item.transitioned_at),
      note: item.note == null ? null : String(item.note), metadata: parseObject(item.metadata_json)
    });
  }
  transitionStatement.free();

  return {
    id, strategy: String(row.strategy), signalId: row.signal_id == null ? null : String(row.signal_id),
    state: String(row.state) as StrategyExecutionState, symbols: parseArray(row.symbols_json), direction: String(row.direction),
    detectedAt: Number(row.detected_at), updatedAt: Number(row.updated_at), closedAt: row.closed_at == null ? null : Number(row.closed_at),
    requestedCapitalToman: row.requested_capital_toman == null ? null : Number(row.requested_capital_toman),
    plannedProfitToman: row.planned_profit_toman == null ? null : Number(row.planned_profit_toman),
    actualOutputToman: row.actual_output_toman == null ? null : Number(row.actual_output_toman),
    actualProfitToman: row.actual_profit_toman == null ? null : Number(row.actual_profit_toman),
    error: row.error == null ? null : String(row.error), metadata: parseObject(row.metadata_json), orders,
    transitions: executionTransitions
  };
}
