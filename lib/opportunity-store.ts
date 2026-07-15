import path from "node:path";
import { createHash } from "node:crypto";
import { openNativeDatabase, type NativeDatabase } from "@/lib/db/native-sqlite";
import type { Opportunity } from "@/lib/bot/types";
import type { ExecutionLeg } from "@/lib/bot/executor";
import type { BotSettings } from "@/lib/bot-settings";
import { serializeOpportunity } from "@/lib/serializers";

type OpportunityMode = "paper" | "live";
type DbState = { db: NativeDatabase; filename: string };
type DbGlobal = typeof globalThis & { __bitgetOpportunityDbs?: Map<string, Promise<DbState>> };

async function database() {
  const globalDb = globalThis as DbGlobal;
  const filename = opportunityDatabaseFilename();
  globalDb.__bitgetOpportunityDbs ??= new Map();
  const existing = globalDb.__bitgetOpportunityDbs.get(filename);
  if (existing) return existing;
  const initialized = initializeDatabase(filename);
  globalDb.__bitgetOpportunityDbs.set(filename, initialized);
  return initialized;
}

function opportunityDatabaseFilename() {
  const configured = process.env.OPPORTUNITY_DB_PATH
    ?? (process.env.NODE_ENV === "test"
      ? ":memory:"
      : path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "arbitrage.sqlite"));
  return configured === ":memory:" ? configured : path.resolve(/*turbopackIgnore: true*/ configured);
}

async function initializeDatabase(filename: string): Promise<DbState> {
  const db = await openNativeDatabase(filename);
  db.run(`
    CREATE TABLE IF NOT EXISTS profitable_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_key TEXT NOT NULL,
      minute_bucket INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('paper', 'live')),
      route_json TEXT NOT NULL,
      legs_json TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      detections INTEGER NOT NULL DEFAULT 1,
      input_toman REAL NOT NULL,
      latest_output_toman REAL NOT NULL,
      latest_profit_toman REAL NOT NULL,
      latest_profit_bps REAL NOT NULL,
      best_profit_toman REAL NOT NULL,
      best_profit_bps REAL NOT NULL,
      executable INTEGER NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      rejection_reason TEXT,
      hidden_at INTEGER,
      UNIQUE(route_key, minute_bucket, mode)
    );
    CREATE INDEX IF NOT EXISTS idx_profitable_last_seen ON profitable_opportunities(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_profitable_route ON profitable_opportunities(route_key);
  `);
  ensureOpportunityHistorySchema(db);
  ensureLiveExecutionSchema(db);
  return { db, filename };
}

function ensureOpportunityHistorySchema(db: NativeDatabase) {
  const columns = new Set(
    (db.exec("PRAGMA table_info(profitable_opportunities)")[0]?.values ?? []).map(row => String(row[1]))
  );
  if (!columns.has("settings_json")) db.run("ALTER TABLE profitable_opportunities ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has("rejection_reason")) db.run("ALTER TABLE profitable_opportunities ADD COLUMN rejection_reason TEXT");
  if (!columns.has("hidden_at")) db.run("ALTER TABLE profitable_opportunities ADD COLUMN hidden_at INTEGER");
}

function ensureLiveExecutionSchema(db: NativeDatabase) {
  db.run(`
    CREATE TABLE IF NOT EXISTS live_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_key TEXT NOT NULL,
      route_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PREPARING', 'RUNNING', 'COMPLETED', 'FAILED')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      requested_input_toman REAL NOT NULL,
      planned_input_toman REAL,
      planned_output_toman REAL,
      planned_profit_toman REAL,
      actual_output_toman REAL,
      actual_profit_toman REAL,
      realized_output_toman REAL,
      realized_profit_toman REAL,
      residual_value_toman REAL,
      residual_inventory_json TEXT NOT NULL DEFAULT '[]',
      fully_settled INTEGER,
      orders_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      hidden_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_live_executions_started ON live_executions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_live_executions_status ON live_executions(status);
  `);
  const columns = new Set(
    (db.exec("PRAGMA table_info(live_executions)")[0]?.values ?? []).map(row => String(row[1]))
  );
  if (!columns.has("hidden_at")) db.run("ALTER TABLE live_executions ADD COLUMN hidden_at INTEGER");
  if (!columns.has("realized_output_toman")) db.run("ALTER TABLE live_executions ADD COLUMN realized_output_toman REAL");
  if (!columns.has("realized_profit_toman")) db.run("ALTER TABLE live_executions ADD COLUMN realized_profit_toman REAL");
  if (!columns.has("residual_value_toman")) db.run("ALTER TABLE live_executions ADD COLUMN residual_value_toman REAL");
  if (!columns.has("residual_inventory_json")) db.run("ALTER TABLE live_executions ADD COLUMN residual_inventory_json TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has("fully_settled")) db.run("ALTER TABLE live_executions ADD COLUMN fully_settled INTEGER");
}

function persist(state: DbState) {
  // Native SQLite persists every committed transaction itself. Keeping this
  // function avoids a risky broad rewrite of the store call sites.
  void state;
}

export async function saveProfitableOpportunities(opportunities: Opportunity[], mode: OpportunityMode, settings?: BotSettings) {
  const profitable = opportunities.filter(item => item.netProfitToman.gt(0) && item.liquiditySafe);
  if (!profitable.length) return 0;
  const state = await database();
  ensureOpportunityHistorySchema(state.db);
  // Strategy Lab تنظیمات مستقلی دارد و نباید تغییر آن، snapshot تاریخی Triangle را به رکورد تازه تبدیل کند.
  const triangleSettings = settings ? Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "strategyLab")) : {};
  const settingsJson = JSON.stringify(triangleSettings);
  const settingsKey = settings
    ? createHash("sha256").update(settingsJson).digest("hex").slice(0, 16)
    : "legacy";
  const statement = state.db.prepare(`
    INSERT INTO profitable_opportunities (
      route_key, minute_bucket, mode, route_json, legs_json, first_seen_at, last_seen_at,
      detections, input_toman, latest_output_toman, latest_profit_toman, latest_profit_bps,
      best_profit_toman, best_profit_bps, executable, settings_json, rejection_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(route_key, minute_bucket, mode) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      first_seen_at = CASE WHEN profitable_opportunities.hidden_at IS NULL
        THEN profitable_opportunities.first_seen_at ELSE excluded.first_seen_at END,
      detections = CASE WHEN profitable_opportunities.hidden_at IS NULL
        THEN profitable_opportunities.detections + 1 ELSE 1 END,
      route_json = excluded.route_json,
      legs_json = excluded.legs_json,
      input_toman = excluded.input_toman,
      latest_output_toman = excluded.latest_output_toman,
      latest_profit_toman = excluded.latest_profit_toman,
      latest_profit_bps = excluded.latest_profit_bps,
      best_profit_toman = CASE WHEN profitable_opportunities.hidden_at IS NULL
        THEN MAX(profitable_opportunities.best_profit_toman, excluded.best_profit_toman)
        ELSE excluded.best_profit_toman END,
      best_profit_bps = CASE WHEN profitable_opportunities.hidden_at IS NULL
        THEN MAX(profitable_opportunities.best_profit_bps, excluded.best_profit_bps)
        ELSE excluded.best_profit_bps END,
      executable = CASE WHEN profitable_opportunities.hidden_at IS NULL
        THEN MAX(profitable_opportunities.executable, excluded.executable)
        ELSE excluded.executable END,
      settings_json = excluded.settings_json,
      rejection_reason = excluded.rejection_reason,
      hidden_at = NULL
  `);
  state.db.run("BEGIN");
  try {
    for (const item of profitable) {
      const serialized = serializeOpportunity(item);
      statement.run([
        `${item.id}::cfg:${settingsKey}`,
        Math.floor(item.scannedAt / 60_000) * 60_000,
        mode,
        JSON.stringify(item.route),
        JSON.stringify(serialized.legs),
        item.scannedAt,
        item.scannedAt,
        item.inputToman.toNumber(),
        item.outputToman.toNumber(),
        item.netProfitToman.toNumber(),
        item.profitBps.toNumber(),
        item.netProfitToman.toNumber(),
        item.profitBps.toNumber(),
        item.executable ? 1 : 0,
        settingsJson,
        item.rejectionReason ?? null
      ]);
    }
    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  } finally {
    statement.free();
  }
  persist(state);
  return profitable.length;
}

export async function clearOpportunityHistory() {
  const state = await database();
  ensureOpportunityHistorySchema(state.db);
  const count = Number(state.db.exec("SELECT COUNT(*) FROM profitable_opportunities WHERE hidden_at IS NULL")[0]?.values[0]?.[0] ?? 0);
  if (!count) return 0;
  state.db.run("BEGIN");
  try {
    state.db.run("UPDATE profitable_opportunities SET hidden_at = ? WHERE hidden_at IS NULL", [Date.now()]);
    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
  persist(state);
  return count;
}

/**
 * Permanently removes every row owned by the opportunity/triangle database.
 * This is intentionally separate from dashboard history archival and must only
 * be called by the guarded administrative purge route.
 */
export async function purgeAllOpportunityDatabaseData() {
  const state = await database();
  ensureOpportunityHistorySchema(state.db);
  ensureLiveExecutionSchema(state.db);
  const opportunities = Number(state.db.exec("SELECT COUNT(*) FROM profitable_opportunities")[0]?.values[0]?.[0] ?? 0);
  const liveExecutions = Number(state.db.exec("SELECT COUNT(*) FROM live_executions")[0]?.values[0]?.[0] ?? 0);
  state.db.run("BEGIN IMMEDIATE");
  try {
    state.db.run("DELETE FROM profitable_opportunities");
    state.db.run("DELETE FROM live_executions");
    state.db.run("DELETE FROM sqlite_sequence WHERE name IN ('profitable_opportunities', 'live_executions')");
    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
  persist(state);
  return { opportunities, liveExecutions, total: opportunities + liveExecutions };
}

export async function getOpportunityHistory(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const { db } = await database();
  ensureOpportunityHistorySchema(db);
  const summaryResult = db.exec(`
    SELECT COUNT(*) AS recordCount, COALESCE(SUM(detections), 0) AS detectionCount,
      COUNT(DISTINCT route_json) AS uniqueRouteCount,
      COALESCE(MAX(best_profit_toman), 0) AS bestProfitToman,
      COALESCE(MAX(best_profit_bps), 0) AS bestProfitBps
    FROM profitable_opportunities
    WHERE hidden_at IS NULL
  `)[0];
  const summary = Object.fromEntries((summaryResult?.columns ?? []).map((column, index) => [column, Number(summaryResult?.values[0]?.[index] ?? 0)]));
  const statement = db.prepare(`
    SELECT id, mode, route_json, legs_json, first_seen_at, last_seen_at, detections,
      input_toman, latest_output_toman, latest_profit_toman, latest_profit_bps,
      best_profit_toman, best_profit_bps, executable, settings_json, rejection_reason
    FROM profitable_opportunities WHERE hidden_at IS NULL ORDER BY last_seen_at DESC LIMIT ?
  `);
  statement.bind([safeLimit]);
  const rows: Array<Record<string, unknown>> = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return {
    summary,
    records: rows.map(row => ({
      id: Number(row.id), mode: String(row.mode),
      route: JSON.parse(String(row.route_json)), legs: JSON.parse(String(row.legs_json)),
      firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at), detections: Number(row.detections),
      inputToman: Number(row.input_toman), latestOutputToman: Number(row.latest_output_toman),
      latestProfitToman: Number(row.latest_profit_toman), latestProfitBps: Number(row.latest_profit_bps),
      bestProfitToman: Number(row.best_profit_toman), bestProfitBps: Number(row.best_profit_bps),
      executable: Boolean(row.executable),
      settings: JSON.parse(String(row.settings_json || "{}")),
      rejectionReason: row.rejection_reason == null ? null : String(row.rejection_reason)
    }))
  };
}

export async function createLiveExecutionAttempt(opportunity: Opportunity) {
  const state = await database();
  ensureLiveExecutionSchema(state.db);
  state.db.run(`
    INSERT INTO live_executions (
      route_key, route_json, status, started_at, requested_input_toman,
      planned_input_toman, planned_output_toman, planned_profit_toman, orders_json
    ) VALUES (?, ?, 'PREPARING', ?, ?, ?, ?, ?, '[]')
  `, [
    opportunity.id,
    JSON.stringify(opportunity.route),
    Date.now(),
    opportunity.requestedInputToman.toNumber(),
    opportunity.inputToman.toNumber(),
    opportunity.outputToman.toNumber(),
    opportunity.netProfitToman.toNumber()
  ]);
  const id = Number(state.db.exec("SELECT last_insert_rowid() AS id")[0]?.values[0]?.[0]);
  persist(state);
  return id;
}

export async function createLiveExecutionTrigger(input: { routeKey: string; route: string[]; requestedInputToman: number }) {
  const state = await database();
  ensureLiveExecutionSchema(state.db);
  state.db.run(`
    INSERT INTO live_executions (
      route_key, route_json, status, started_at, requested_input_toman, orders_json
    ) VALUES (?, ?, 'PREPARING', ?, ?, '[]')
  `, [input.routeKey, JSON.stringify(input.route), Date.now(), input.requestedInputToman]);
  const id = Number(state.db.exec("SELECT last_insert_rowid() AS id")[0]?.values[0]?.[0]);
  persist(state);
  return id;
}

export async function markLiveExecutionPrepared(id: number, opportunity: Opportunity) {
  const state = await database();
  ensureLiveExecutionSchema(state.db);
  state.db.run(`
    UPDATE live_executions SET status = 'RUNNING', route_key = ?, route_json = ?,
      requested_input_toman = ?, planned_input_toman = ?, planned_output_toman = ?, planned_profit_toman = ?
    WHERE id = ?
  `, [
    opportunity.id,
    JSON.stringify(opportunity.route),
    opportunity.requestedInputToman.toNumber(),
    opportunity.inputToman.toNumber(),
    opportunity.outputToman.toNumber(),
    opportunity.netProfitToman.toNumber(),
    id
  ]);
  persist(state);
}

export async function updateLiveExecutionOrders(id: number, orders: ExecutionLeg[]) {
  const state = await database();
  ensureLiveExecutionSchema(state.db);
  state.db.run("UPDATE live_executions SET orders_json = ? WHERE id = ?", [JSON.stringify(orders), id]);
  persist(state);
}

export async function completeLiveExecution(id: number, result: {
  outputToman: { toNumber(): number };
  profitToman: { toNumber(): number };
  realizedOutputToman?: { toNumber(): number };
  realizedProfitToman?: { toNumber(): number };
  residualValueToman?: { toNumber(): number };
  residualInventory?: Array<{ asset: string; amount: { toString(): string } }>;
  fullySettled?: boolean;
  legs: ExecutionLeg[];
}) {
  const state = await database();
  ensureLiveExecutionSchema(state.db);
  state.db.run(`
    UPDATE live_executions SET status = 'COMPLETED', completed_at = ?, actual_output_toman = ?,
      actual_profit_toman = ?, realized_output_toman = ?, realized_profit_toman = ?,
      residual_value_toman = ?, residual_inventory_json = ?, fully_settled = ?,
      orders_json = ?, error = NULL WHERE id = ?
  `, [
    Date.now(),
    result.outputToman.toNumber(),
    result.profitToman.toNumber(),
    result.realizedOutputToman?.toNumber() ?? result.outputToman.toNumber(),
    result.realizedProfitToman?.toNumber() ?? result.profitToman.toNumber(),
    result.residualValueToman?.toNumber() ?? 0,
    JSON.stringify((result.residualInventory ?? []).map(position => ({
      asset: position.asset,
      amount: position.amount.toString()
    }))),
    result.fullySettled === undefined ? 1 : Number(result.fullySettled),
    JSON.stringify(result.legs),
    id
  ]);
  persist(state);
}

export async function failLiveExecution(id: number, error: string, realized?: {
  actualOutputToman: number;
  actualProfitToman: number;
  realizedOutputToman?: number;
  realizedProfitToman?: number;
  residualValueToman?: number;
  residualInventory?: Array<{ asset: string; amount: string }>;
  fullySettled?: boolean;
}) {
  const state = await database();
  ensureLiveExecutionSchema(state.db);
  state.db.run(`
    UPDATE live_executions SET status = 'FAILED', completed_at = ?, error = ?,
      actual_output_toman = COALESCE(?, actual_output_toman),
      actual_profit_toman = COALESCE(?, actual_profit_toman),
      realized_output_toman = COALESCE(?, realized_output_toman),
      realized_profit_toman = COALESCE(?, realized_profit_toman),
      residual_value_toman = COALESCE(?, residual_value_toman),
      residual_inventory_json = CASE WHEN ? IS NULL THEN residual_inventory_json ELSE ? END,
      fully_settled = COALESCE(?, fully_settled)
    WHERE id = ?
  `, [
    Date.now(),
    error,
    realized?.actualOutputToman ?? null,
    realized?.actualProfitToman ?? null,
    realized?.realizedOutputToman ?? null,
    realized?.realizedProfitToman ?? null,
    realized?.residualValueToman ?? null,
    realized?.residualInventory === undefined ? null : 1,
    JSON.stringify(realized?.residualInventory ?? []),
    realized?.fullySettled === undefined ? null : Number(realized.fullySettled),
    id
  ]);
  persist(state);
}

export async function getLiveExecutionHistory(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const { db } = await database();
  ensureLiveExecutionSchema(db);
  const summaryResult = db.exec(`
    SELECT COUNT(*) AS attemptCount,
      COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completedCount,
      COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failedCount,
      COALESCE(SUM(CASE WHEN status IN ('PREPARING', 'RUNNING') THEN 1 ELSE 0 END), 0) AS runningCount,
      COALESCE(SUM(actual_profit_toman), 0) AS totalActualProfitToman
    FROM live_executions
    WHERE hidden_at IS NULL
  `)[0];
  const summary = Object.fromEntries((summaryResult?.columns ?? []).map((column, index) => [column, Number(summaryResult?.values[0]?.[index] ?? 0)]));
  const statement = db.prepare(`
    SELECT id, route_json, status, started_at, completed_at, requested_input_toman,
      planned_input_toman, planned_output_toman, planned_profit_toman,
      actual_output_toman, actual_profit_toman, realized_output_toman,
      realized_profit_toman, residual_value_toman, residual_inventory_json,
      fully_settled, orders_json, error
    FROM live_executions WHERE hidden_at IS NULL ORDER BY started_at DESC LIMIT ?
  `);
  statement.bind([safeLimit]);
  const rows: Array<Record<string, unknown>> = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return {
    summary,
    records: rows.map(row => ({
      id: Number(row.id),
      route: JSON.parse(String(row.route_json)),
      status: String(row.status),
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      requestedInputToman: Number(row.requested_input_toman),
      plannedInputToman: row.planned_input_toman === null ? null : Number(row.planned_input_toman),
      plannedOutputToman: row.planned_output_toman === null ? null : Number(row.planned_output_toman),
      plannedProfitToman: row.planned_profit_toman === null ? null : Number(row.planned_profit_toman),
      actualOutputToman: row.actual_output_toman === null ? null : Number(row.actual_output_toman),
      actualProfitToman: row.actual_profit_toman === null ? null : Number(row.actual_profit_toman),
      realizedOutputToman: row.realized_output_toman === null ? null : Number(row.realized_output_toman),
      realizedProfitToman: row.realized_profit_toman === null ? null : Number(row.realized_profit_toman),
      residualValueToman: row.residual_value_toman === null ? null : Number(row.residual_value_toman),
      residualInventory: JSON.parse(String(row.residual_inventory_json || "[]")),
      fullySettled: row.fully_settled === null ? null : Boolean(row.fully_settled),
      orders: JSON.parse(String(row.orders_json || "[]")),
      error: row.error === null ? null : String(row.error)
    }))
  };
}

export type UnfinishedLiveExecution = {
  id: number;
  status: "PREPARING" | "RUNNING";
  startedAt: number;
  orders: unknown[];
  ordersCorrupt: boolean;
};

/**
 * Returns every unfinished Triangle execution, including rows hidden from the
 * dashboard. Startup reconciliation must not rely on a paginated UI history:
 * missing even one exchange-facing attempt could allow duplicate exposure.
 */
export async function getUnfinishedLiveExecutions(): Promise<UnfinishedLiveExecution[]> {
  const { db } = await database();
  ensureLiveExecutionSchema(db);
  const statement = db.prepare(`
    SELECT id, status, started_at, orders_json
    FROM live_executions
    WHERE status IN ('PREPARING', 'RUNNING')
    ORDER BY id ASC
  `);
  statement.bind([]);
  const records: UnfinishedLiveExecution[] = [];
  while (statement.step()) {
    const row = statement.getAsObject();
    const parsed = parsePersistedOrders(row.orders_json);
    records.push({
      id: Number(row.id),
      status: String(row.status) as UnfinishedLiveExecution["status"],
      startedAt: Number(row.started_at),
      orders: parsed.orders,
      ordersCorrupt: parsed.corrupt
    });
  }
  statement.free();
  return records;
}

/** Includes hidden/failed rows whose order evidence may still represent exposure. */
export async function countUnsafeLiveExecutionRecords() {
  const { db } = await database();
  ensureLiveExecutionSchema(db);
  return Number(db.exec(`
    SELECT COUNT(*) FROM live_executions
    WHERE status IN ('PREPARING', 'RUNNING')
      OR (
        status = 'FAILED'
        AND actual_output_toman IS NULL
        AND TRIM(COALESCE(orders_json, '[]')) <> '[]'
      )
  `)[0]?.values[0]?.[0] ?? 0);
}

function parsePersistedOrders(value: unknown): { orders: unknown[]; corrupt: boolean } {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed)
      ? { orders: parsed, corrupt: false }
      : { orders: [], corrupt: true };
  } catch {
    // Corrupt execution evidence is ambiguous. The startup audit therefore
    // treats it like an exchange-facing attempt and enters manual review.
    return { orders: [], corrupt: true };
  }
}

/**
 * Hides dashboard-safe Triangle rows without deleting the financial audit.
 * Ambiguous exchange-facing attempts remain visible for reconciliation.
 */
export async function clearDashboardLiveExecutionHistory(
  staleBefore = Date.now() - 5 * 60_000
) {
  const state = await database();
  ensureLiveExecutionSchema(state.db);
  const clearable = state.db.prepare(`
    SELECT id FROM live_executions
    WHERE hidden_at IS NULL
      AND (
      status = 'COMPLETED'
      OR (
        status = 'FAILED'
        AND (
          actual_output_toman IS NOT NULL
          OR (
            TRIM(COALESCE(orders_json, '[]')) = '[]'
            AND (error LIKE 'بدون ارسال سفارش:%' OR error LIKE 'No order submitted:%')
          )
        )
      )
      OR (
        status = 'PREPARING'
        AND TRIM(COALESCE(orders_json, '[]')) = '[]'
        AND started_at <= ?
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
    state.db.run(`UPDATE live_executions SET hidden_at = ? WHERE id IN (${placeholders})`, [Date.now(), ...ids]);
    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }
  persist(state);
  return ids.length;
}
