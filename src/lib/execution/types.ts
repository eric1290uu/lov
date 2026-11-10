// Shared execution-layer types (browser-safe, no IO).
export type Side = "LONG" | "SHORT";
export type ExecMode = "off" | "paper" | "live";
export type BrokerMode = "paper" | "live";

export type OrderStatus =
  | "PENDING" // row written locally, broker outcome not yet known
  | "SUBMITTED" // broker accepted the bracket; entry working
  | "PARTIALLY_FILLED"
  | "OPEN" // entry filled, protective stop confirmed live at the broker
  | "NEEDS_ATTENTION" // entry filled but the stop is NOT confirmed live (the dangerous state)
  | "CLOSED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

export type ExitReason =
  "STOP" | "TARGET" | "TIME" | "EOD" | "KILL_SWITCH" | "UNPROTECTED" | "MANUAL";

export interface ExecutionSettings {
  userId: string;
  mode: ExecMode;
  killSwitch: boolean;
  liveArmedAt: string | null;
  allowShort: boolean;
  maxOpenPositions: number;
  maxPositionPct: number;
  maxDailyLossPct: number;
  maxOpenRiskPct: number; // read from user_preferences.max_open_risk_pct so journal and execution share one limit
  minRr: number;
  maxSetupAgeMin: number;
  entryCollarBps: number;
  maxHoldMin: number; // longest a position may stay open (minutes)
  flattenMinBeforeClose: number; // everything is closed this many minutes before the bell: no overnight risk
  flattenUnprotected: boolean;
  // --- intraday controls
  entryExpiryBars: number; // cancel an unfilled entry after this many bars
  avoidOpenMin: number; // no entries in the first N minutes after the open
  maxTradesPerDay: number;
  maxConsecutiveLosses: number; // halts new entries for the rest of the day
  tickerCooldownMin: number; // after a loss on a ticker
  estCostBps: number; // assumed round-trip cost (spread + slippage), in basis points
  minCostMultiple: number; // target distance must be at least this many times the cost
  // --- autopilot
  autopilotEnabled: boolean;
  autopilotTimeframe: "5m" | "15m";
}

export const DEFAULT_SETTINGS: Omit<ExecutionSettings, "userId"> = {
  mode: "off",
  killSwitch: false,
  liveArmedAt: null,
  allowShort: false,
  maxOpenPositions: 5,
  maxPositionPct: 20,
  maxDailyLossPct: 2,
  maxOpenRiskPct: 6,
  minRr: 1.5,
  maxSetupAgeMin: 20,
  entryCollarBps: 10,
  maxHoldMin: 180,
  flattenMinBeforeClose: 15,
  flattenUnprotected: true,
  entryExpiryBars: 2,
  avoidOpenMin: 10,
  maxTradesPerDay: 10,
  maxConsecutiveLosses: 3,
  tickerCooldownMin: 30,
  estCostBps: 8,
  minCostMultiple: 4,
  autopilotEnabled: false,
  autopilotTimeframe: "15m",
};

export interface OrderRow {
  id: string;
  userId: string;
  setupId: string | null;
  ticker: string;
  side: Side;
  mode: BrokerMode;
  broker: string;
  clientOrderId: string;
  brokerOrderId: string | null;
  status: OrderStatus;
  qty: number;
  limitPrice: number;
  stopPrice: number;
  takePrice: number;
  filledQty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: ExitReason | null;
  exitHint: ExitReason | null;
  realizedPnl: number | null;
  statusReason: string | null;
  expiresAt: string | null;
  submittedAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  version: number;
  createdAt: string;
}

/** The slice of a trade_setups row the execution layer needs. */
export interface SetupRow {
  id: string;
  userId: string;
  ticker: string;
  side: Side | null;
  status: string;
  timeframe: string;
  createdAt: string;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  preferredEntry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  positionShares: number | null;
  riskPercent: number | null;
  accountSize: number | null;
}

export const ACTIVE_STATUSES: OrderStatus[] = [
  "PENDING",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "OPEN",
  "NEEDS_ATTENTION",
];
export const isActive = (s: OrderStatus) => ACTIVE_STATUSES.includes(s);

/** Fields a user may change from the UI. mode can only be off|paper here; live goes through armLive. */
export interface SettingsPatch {
  mode?: "off" | "paper" | undefined;
  allowShort?: boolean | undefined;
  maxOpenPositions?: number | undefined;
  maxPositionPct?: number | undefined;
  maxDailyLossPct?: number | undefined;
  minRr?: number | undefined;
  maxSetupAgeMin?: number | undefined;
  entryCollarBps?: number | undefined;
  maxHoldMin?: number | undefined;
  flattenMinBeforeClose?: number | undefined;
  flattenUnprotected?: boolean | undefined;
  entryExpiryBars?: number | undefined;
  avoidOpenMin?: number | undefined;
  maxTradesPerDay?: number | undefined;
  maxConsecutiveLosses?: number | undefined;
  tickerCooldownMin?: number | undefined;
  estCostBps?: number | undefined;
  minCostMultiple?: number | undefined;
  autopilotEnabled?: boolean | undefined;
  autopilotTimeframe?: "5m" | "15m" | undefined;
}
