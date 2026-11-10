import type { ExecutionSettings, OrderRow, SetupRow, BrokerMode } from "./types";
import type { Patch } from "./state";

export class DuplicateOrderError extends Error {
  constructor() {
    super("duplicate order");
    this.name = "DuplicateOrderError";
  }
}

export interface NewOrder {
  userId: string;
  setupId: string;
  ticker: string;
  side: OrderRow["side"];
  mode: BrokerMode;
  broker: string;
  clientOrderId: string;
  qty: number;
  limitPrice: number;
  stopPrice: number;
  takePrice: number;
  expiresAt: string;
}
export interface EventLog {
  userId: string;
  orderId: string | null;
  kind: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: unknown;
}

/** Persistence port. The Supabase implementation lives in supabase-store.server.ts; tests use the in-memory one. */
export interface Store {
  getSettings(userId: string): Promise<ExecutionSettings | null>;
  setKillSwitch(userId: string, on: boolean): Promise<void>;
  getSetup(userId: string, setupId: string): Promise<SetupRow | null>;
  activeOrders(userId: string, mode: BrokerMode): Promise<OrderRow[]>;
  /** Throws DuplicateOrderError when client_order_id or the one-active-order-per-ticker rule is violated. */
  insertOrder(o: NewOrder): Promise<OrderRow>;
  /** Optimistic update: applies only if version still matches; returns the new row, or null on conflict. */
  updateOrder(id: string, expectedVersion: number, patch: Patch): Promise<OrderRow | null>;
  /** Orders created since `sinceIso` that are, or are about to become, trades (everything except rejected / cancelled / expired). */
  tradesSince(userId: string, mode: BrokerMode, sinceIso: string): Promise<number>;
  /** Orders closed since `sinceIso`, newest first. Used for the day's loss streak and per-ticker cooldown. */
  closedSince(
    userId: string,
    mode: BrokerMode,
    sinceIso: string,
  ): Promise<{ ticker: string; realizedPnl: number | null; closedAt: string }[]>;
  logEvent(e: EventLog): Promise<void>;
  hasRecentEvent(userId: string, kind: string, key: string, withinMin: number): Promise<boolean>;
  notify(userId: string, text: string): Promise<void>;
  /** (user, mode) pairs that need reconciling: active orders, or execution switched on. */
  reconcileTargets(): Promise<{ userId: string; mode: BrokerMode }[]>;
}

export interface AutopilotRun {
  userId: string;
  barId: number;
  timeframe: string;
  status: "running" | "done";
  cursor: number;
  tickersTotal: number;
  setupsFound: number;
  ordersPlaced: number;
  skipped: Record<string, string>;
  errors: string[];
}
/** Persistence port for the autopilot scan. */
export interface AutopilotStore {
  autopilotUsers(): Promise<string[]>;
  watchlist(userId: string, timeframe: string): Promise<string[]>;
  getRun(userId: string, barId: number): Promise<AutopilotRun | null>;
  saveRun(run: AutopilotRun): Promise<void>;
}
