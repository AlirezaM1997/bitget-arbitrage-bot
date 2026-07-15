import { describe, expect, test } from "bun:test";
import { POST } from "@/app/api/strategies/auto-execute/route";

function request(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/strategies/auto-execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin,
      "x-strategy-action": "bitget-dashboard"
    },
    body: JSON.stringify(body)
  });
}

describe("disabled legacy strategy execution route", () => {
  test("never dispatches a legacy engine in the Bitget Triangle runtime", async () => {
    for (const body of [
      { kind: "orderbook-imbalance", signalId: "imbalance:XUSDT" },
      { kind: "orderbook-gap", signalId: "gap:BTCUSDT:ask:1" },
      { kind: "market-making", signalId: "maker:BTCUSDT" }
    ]) {
      const response = await POST(request(body));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "ENGINE_UNAVAILABLE" });
    }
  });

  test("does not expose a different execution path to a foreign origin", async () => {
    const response = await POST(request(
      { kind: "orderbook-imbalance", signalId: "imbalance:XUSDT" },
      "https://attacker.example"
    ));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "ENGINE_UNAVAILABLE" });
  });
});
