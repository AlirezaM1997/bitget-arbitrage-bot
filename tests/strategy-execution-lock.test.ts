import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireStrategyExecutionRecordLock,
  releaseStrategyExecutionRecordLock
} from "@/lib/strategy-execution-lock";

let directory = "";

beforeEach(async () => {
  directory = path.join(tmpdir(), `bitget-position-lock-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  process.env.STRATEGY_EXECUTION_LOCK_PATH = path.join(directory, "position");
});

afterEach(async () => {
  delete process.env.STRATEGY_EXECUTION_LOCK_PATH;
  await rm(directory, { recursive: true, force: true });
});

describe("strategy execution record lock", () => {
  test("fences the same position while allowing a different record", async () => {
    const now = 1_000;
    const first = await acquireStrategyExecutionRecordLock({ executionId: 42, owner: "entry", ttlMs: 5_000, now });
    expect(first.acquired).toBe(true);
    expect((await acquireStrategyExecutionRecordLock({ executionId: 42, owner: "recovery", ttlMs: 5_000, now })).acquired).toBe(false);
    expect((await acquireStrategyExecutionRecordLock({ executionId: 43, owner: "other-position", ttlMs: 5_000, now })).acquired).toBe(true);
    if (first.acquired) expect(await releaseStrategyExecutionRecordLock(first.lock)).toBe(true);
  });

  test("does not take an expired generation away from a live owner", async () => {
    const first = await acquireStrategyExecutionRecordLock({ executionId: 7, owner: "entry", ttlMs: 100, now: 1_000 });
    const second = await acquireStrategyExecutionRecordLock({ executionId: 7, owner: "recovery", ttlMs: 1_000, now: 1_101 });
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    if (first.acquired) expect(await releaseStrategyExecutionRecordLock(first.lock)).toBe(true);
  });

  test("atomically takes over a generation whose process is gone", async () => {
    const target = `${process.env.STRATEGY_EXECUTION_LOCK_PATH}.9.lock`;
    await writeFile(target, JSON.stringify({
      version: 1,
      executionId: 9,
      owner: "dead-worker",
      pid: 2_147_483_647,
      token: "00000000-0000-4000-8000-000000000099",
      acquiredAt: new Date(1_000).toISOString(),
      expiresAt: new Date(1_100).toISOString()
    }));
    const recovered = await acquireStrategyExecutionRecordLock({ executionId: 9, owner: "recovery", ttlMs: 1_000, now: 2_000 });
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) expect(await releaseStrategyExecutionRecordLock(recovered.lock)).toBe(true);
  });
});
