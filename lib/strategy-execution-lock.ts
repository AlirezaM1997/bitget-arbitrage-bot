import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export type StrategyExecutionRecordLock = {
  version: 1;
  executionId: number;
  owner: string;
  pid: number;
  token: string;
  acquiredAt: string;
  expiresAt: string;
};

export type StrategyExecutionRecordLockResult =
  | { acquired: true; lock: StrategyExecutionRecordLock }
  | { acquired: false };

function lockRoot() {
  return process.env.STRATEGY_EXECUTION_LOCK_PATH?.trim()
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "strategy-position");
}

function lockPath(executionId: number) {
  return `${lockRoot()}.${executionId}.lock`;
}

function takeoverPath(executionId: number, token: string) {
  return `${lockPath(executionId)}.takeover.${token}`;
}

function validInput(executionId: number, owner: string, ttlMs: number) {
  return Number.isSafeInteger(executionId) && executionId > 0
    && owner.length > 0 && owner.length <= 200
    && Number.isSafeInteger(ttlMs) && ttlMs >= 100 && ttlMs <= 600_000;
}

async function readLock(executionId: number): Promise<StrategyExecutionRecordLock | undefined> {
  try {
    const value = JSON.parse(await readFile(/*turbopackIgnore: true*/ lockPath(executionId), "utf8")) as Partial<StrategyExecutionRecordLock>;
    if (value.version !== 1 || value.executionId !== executionId || typeof value.owner !== "string"
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== "string"
      || typeof value.acquiredAt !== "string" || typeof value.expiresAt !== "string") return undefined;
    return value as StrategyExecutionRecordLock;
  } catch {
    return undefined;
  }
}

async function createLock(executionId: number, owner: string, ttlMs: number, nowMs: number) {
  const target = lockPath(executionId);
  await mkdir(path.dirname(target), { recursive: true });
  const lock: StrategyExecutionRecordLock = {
    version: 1,
    executionId,
    owner,
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString()
  };
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(lock), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

export async function acquireStrategyExecutionRecordLock(input: {
  executionId: number;
  owner: string;
  ttlMs: number;
  now?: number;
}): Promise<StrategyExecutionRecordLockResult> {
  const owner = input.owner.trim();
  const nowMs = input.now ?? Date.now();
  if (!validInput(input.executionId, owner, input.ttlMs) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid strategy execution record lock request");
  }
  let created = await createLock(input.executionId, owner, input.ttlMs, nowMs);
  if (created) return { acquired: true, lock: created };

  const existing = await readLock(input.executionId);
  // Expiry alone never fences a live worker. A slow API response must not let a
  // recovery worker take the same Position; takeover is allowed only when the
  // owning process is provably gone. Invalid records remain fail-closed.
  if (!existing || processIsAlive(existing.pid)) return { acquired: false };

  // Every contender for this exact dead generation races on the same immutable
  // claim filename. Only its winner may remove the old token, preventing a
  // delayed contender from deleting a newly-created generation (ABA).
  const claim = takeoverPath(input.executionId, existing.token);
  try {
    const handle = await open(claim, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { acquired: false };
    throw error;
  }
  try {
    const latest = await readLock(input.executionId);
    if (!latest || latest.token !== existing.token || processIsAlive(latest.pid)) return { acquired: false };
    await rm(lockPath(input.executionId), { force: true });
    created = await createLock(input.executionId, owner, input.ttlMs, nowMs);
    return created ? { acquired: true, lock: created } : { acquired: false };
  } finally {
    await rm(claim, { force: true });
  }
}

export async function releaseStrategyExecutionRecordLock(lock: Pick<StrategyExecutionRecordLock, "executionId" | "token">) {
  const current = await readLock(lock.executionId);
  if (!current || current.token !== lock.token) return false;
  await rm(lockPath(lock.executionId), { force: true });
  return true;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
