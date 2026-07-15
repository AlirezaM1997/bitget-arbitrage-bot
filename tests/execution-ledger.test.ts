import { beforeEach, expect, test } from "bun:test";

beforeEach(() => {
  process.env.EXECUTION_LEDGER_DB_PATH = ":memory:";
});

test("execution ledger is immutable, idempotent and hash chained", async () => {
  const { appendExecutionEvent, listExecutionEvents, verifyExecutionLedger } = await import("@/lib/execution-ledger");
  const intent = await appendExecutionEvent({
    executionId: "triangle:42",
    engine: "triangle",
    type: "INTENT",
    idempotencyKey: "triangle:42:intent",
    occurredAt: 1,
    payload: { capitalToman: 1_000_000 }
  });
  const duplicate = await appendExecutionEvent({
    executionId: "triangle:42",
    engine: "triangle",
    type: "INTENT",
    idempotencyKey: "triangle:42:intent",
    occurredAt: 999,
    payload: { capitalToman: 2_000_000 }
  });
  await appendExecutionEvent({
    executionId: "triangle:42",
    engine: "triangle",
    type: "COMPLETED",
    idempotencyKey: "triangle:42:completed",
    occurredAt: 2,
    payload: { realizedPnlToman: 12_500 }
  });

  expect(intent.inserted).toBe(true);
  expect(duplicate.inserted).toBe(false);
  expect(duplicate.event.eventHash).toBe(intent.event.eventHash);
  expect((await listExecutionEvents({ executionId: "triangle:42" })).length).toBe(2);
  expect(await verifyExecutionLedger()).toEqual({ valid: true, checked: 2, invalidEventId: null });
});

test("administrative purge resets the execution audit ledger", async () => {
  const { listExecutionEvents, purgeAllExecutionLedgerData, verifyExecutionLedger } = await import("@/lib/execution-ledger");
  const deleted = await purgeAllExecutionLedgerData();
  expect(deleted.events).toBe(2);
  expect(await listExecutionEvents()).toEqual([]);
  expect(await verifyExecutionLedger()).toEqual({ valid: true, checked: 0, invalidEventId: null });
});
