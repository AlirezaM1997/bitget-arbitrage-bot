import Decimal from "decimal.js";
import type { OrderBook, Side } from "@/lib/exchanges/types";

export type ConversionEdge = {
  id: string;
  from: string;
  to: string;
  side: Side;
  book: OrderBook;
};

export type LegQuote = {
  edge: ConversionEdge;
  input: Decimal;
  grossOutput: Decimal;
  output: Decimal;
  averagePrice: Decimal;
  fee: Decimal;
  slippageBuffer: Decimal;
  levelsUsed: number;
  totalLevels: number;
  bestPrice: Decimal;
  worstPrice: Decimal;
  priceImpactBps: Decimal;
  spreadBps: Decimal;
  availableInput: Decimal;
  depthConsumedPercent: Decimal;
};

export type Opportunity = {
  id: string;
  route: string[];
  legs: LegQuote[];
  requestedInputToman: Decimal;
  inputToman: Decimal;
  outputToman: Decimal;
  netProfitToman: Decimal;
  profitBps: Decimal;
  liquiditySafe: boolean;
  executable: boolean;
  rejectionReason?: string;
  sizedByDepth: boolean;
  sizingMode: "optimized" | "diagnostic-minimum";
  scannedAt: number;
};
