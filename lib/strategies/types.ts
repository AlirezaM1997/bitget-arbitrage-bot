import Decimal from "decimal.js";
import type { StrategyLabSettings } from "@/lib/strategy-settings";
import type { OrderbookObservation } from "./orderbook-history";

export type StrategyKind = "orderbook-gap" | "orderbook-imbalance";
export type StrategySignalStatus = "actionable" | "watch" | "blocked";

export type StrategySignal = {
  id: string;
  kind: StrategyKind;
  title: string;
  symbols: string[];
  action: string;
  status: StrategySignalStatus;
  paperOnly: true;
  expectedEdgeBps: Decimal;
  estimatedNetProfitToman: Decimal;
  confidence: Decimal;
  reasons: string[];
  /** Retained only while migrating old signal copy; dashboards must use `reasons`. */
  legacyReasons?: string[];
  metrics: Record<string, string | number | boolean>;
  scannedAt: number;
};

export type StrategyLabConfig = {
  settings: StrategyLabSettings;
  tomanTakerFeeBps: number;
  usdtTakerFeeBps: number;
  slippageBps: number;
  maxAgeMs: number;
};

export type StrategyLabContext = {
  now?: number;
  orderbookHistory?: ReadonlyMap<string, readonly OrderbookObservation[]>;
};

export type StrategyLabScanResult = {
  scannedAt: number;
  signals: StrategySignal[];
  actionableCount: number;
  watchCount: number;
  enabledCount: number;
  diagnostics: Record<string, string | number | boolean>;
};
