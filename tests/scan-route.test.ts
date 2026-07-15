import { describe, expect, test } from "bun:test";
import { scanModeFromHeader } from "@/app/api/scan/route";

describe("dashboard scan modes", () => {
  test("defaults every non-live request to local Demo simulation", () => {
    expect(scanModeFromHeader(null)).toBe("demo");
    expect(scanModeFromHeader("demo")).toBe("demo");
    expect(scanModeFromHeader("paper")).toBe("demo");
  });

  test("enters Real scan mode only for the exact live header", () => {
    expect(scanModeFromHeader("live")).toBe("live");
    expect(scanModeFromHeader("LIVE")).toBe("demo");
  });
});
