import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlParameters = readonly SqlValue[];
type SqlRow = Record<string, unknown>;

type RawStatement = {
  all: (...parameters: SqlValue[]) => SqlRow[];
  run: (...parameters: SqlValue[]) => unknown;
};

type RawDatabase = {
  prepare?: (sql: string) => RawStatement;
  query?: (sql: string) => RawStatement;
  exec?: (sql: string) => unknown;
  run?: (sql: string) => unknown;
  close: () => void;
};

export type SqlJsResult = {
  columns: string[];
  values: unknown[][];
};

/**
 * Minimal SQL.js-compatible statement surface used by the existing stores.
 * The implementation is backed by the native SQLite driver of the current
 * runtime, so each process participates in SQLite's real file locks and WAL.
 */
export class NativeStatement {
  private parameters: SqlValue[] = [];
  private rows: SqlRow[] | null = null;
  private cursor = -1;

  constructor(private readonly statement: RawStatement) {}

  bind(parameters: SqlParameters = []) {
    this.parameters = [...parameters];
    this.rows = null;
    this.cursor = -1;
    return true;
  }

  step() {
    if (!this.rows) this.rows = this.statement.all(...this.parameters);
    this.cursor += 1;
    return this.cursor < this.rows.length;
  }

  get() {
    return Object.values(this.currentRow());
  }

  getAsObject() {
    return this.currentRow();
  }

  run(parameters: SqlParameters = []) {
    return this.statement.run(...parameters);
  }

  free() {
    this.rows = null;
    this.parameters = [];
    this.cursor = -1;
    return true;
  }

  private currentRow() {
    const row = this.rows?.[this.cursor];
    if (!row) throw new Error("SQLite statement has no current row");
    return row;
  }
}

export class NativeDatabase {
  constructor(private readonly raw: RawDatabase) {}

  run(sql: string, parameters: SqlParameters = []) {
    if (parameters.length) return this.prepare(sql).run(parameters);
    if (this.raw.exec) return this.raw.exec(sql);
    if (this.raw.run) return this.raw.run(sql);
    throw new Error("Native SQLite driver cannot execute SQL");
  }

  exec(sql: string): SqlJsResult[] {
    const rows = this.prepareRaw(sql).all();
    if (!rows.length) return [];
    const columns = Object.keys(rows[0]);
    return [{ columns, values: rows.map(row => columns.map(column => row[column])) }];
  }

  prepare(sql: string) {
    return new NativeStatement(this.prepareRaw(sql));
  }

  close() {
    this.raw.close();
  }

  private prepareRaw(sql: string) {
    const statement = this.raw.prepare?.(sql) ?? this.raw.query?.(sql);
    if (!statement) throw new Error("Native SQLite driver cannot prepare SQL");
    return statement;
  }
}

type BunSqliteModule = {
  Database: new (filename?: string, options?: { create?: boolean; readonly?: boolean }) => RawDatabase;
};

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<unknown>;

export async function openNativeDatabase(filename: string) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });

  let raw: RawDatabase;
  if ((globalThis as { Bun?: unknown }).Bun) {
    const module = await dynamicImport("bun:sqlite") as BunSqliteModule;
    raw = new module.Database(filename, filename === ":memory:" ? undefined : { create: true }) as unknown as RawDatabase;
  } else {
    raw = new BetterSqlite3(filename) as unknown as RawDatabase;
  }

  const database = new NativeDatabase(raw);
  database.run("PRAGMA busy_timeout = 10000");
  database.run("PRAGMA foreign_keys = ON");
  if (filename !== ":memory:") {
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
    database.run("PRAGMA wal_autocheckpoint = 1000");
  }
  return database;
}
