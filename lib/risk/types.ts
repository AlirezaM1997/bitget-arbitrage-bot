export const RISK_STRATEGIES = [
  "triangle",
  "gapTrading",
  "imbalance",
  "aiAgent"
] as const;

export type RiskStrategy = (typeof RISK_STRATEGIES)[number];
export type RiskStrategyId = RiskStrategy;

export interface StrategyReadiness {
  positionStateReady: boolean;
  recoveryReady: boolean;
  executionAdapterReady: boolean;
}

export interface StrategyRiskState {
  enabled: boolean;
  readiness: StrategyReadiness;
}

export interface DailyRiskState {
  date: string;
  realizedPnlToman: number;
  lossToman: number;
  tradeCount: number;
  consecutiveLosses: number;
}

export interface RiskLimits {
  maxDailyLossToman: number;
  maxConcurrentPositions: number;
  /** Stops new entries after this many realized losing executions in a row. */
  maxConsecutiveLosses: number;
}

export interface EmergencyStopState {
  active: boolean;
  reason: string | null;
  triggeredAt: string | null;
}

export interface RiskState {
  version: 1;
  masterArmed: boolean;
  emergencyStop: EmergencyStopState;
  daily: DailyRiskState;
  /** Bounded cross-day set used to make realized-PnL retries idempotent. */
  recordedPnlKeys: string[];
  limits: RiskLimits;
  strategies: Record<RiskStrategy, StrategyRiskState>;
  updatedAt: string;
}

export interface StrategyRiskStatus {
  enabled: boolean;
  ready: boolean;
  canExecute: boolean;
  blockers: string[];
}

export interface RiskEvaluation {
  canExecute: boolean;
  dailyLossBreached: boolean;
  /** Optional on legacy/mocked snapshots; emitted by the current risk store. */
  consecutiveLossBreached?: boolean;
  globalBlockers: string[];
  strategies: Record<RiskStrategy, StrategyRiskStatus>;
}

export interface ExecutionLease {
  version: 1;
  slot: number;
  strategy: RiskStrategy;
  /** Missing on legacy/mock leases and treated as normal execution. */
  purpose?: "execution" | "recovery";
  owner: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export type PublicExecutionLease = Omit<ExecutionLease, "token">;

export type LeaseAcquisition =
  | { acquired: true; lease: ExecutionLease }
  | { acquired: false; reason: "risk-blocked" | "capacity-reached"; blockers: string[] };

export interface RiskControlSnapshot {
  state: RiskState;
  evaluation: RiskEvaluation;
  activeLeases: PublicExecutionLease[];
}

export interface RiskStatePatch {
  limits?: Partial<RiskLimits>;
  strategies?: Partial<Record<RiskStrategy, {
    enabled?: boolean;
    readiness?: Partial<StrategyReadiness>;
  }>>;
}
