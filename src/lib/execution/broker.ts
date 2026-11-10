// Broker-agnostic contract. The engine only talks to this, so swapping Alpaca for IBKR means writing one adapter.
import type { BrokerMode, Side } from "./types";

export type BrokerOrderStatus =
  "working" | "partially_filled" | "filled" | "canceled" | "expired" | "rejected";
export interface BrokerLeg {
  id: string;
  kind: "stop" | "take";
  status: BrokerOrderStatus;
  filledQty: number;
  avgFillPrice: number | null;
}
export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  status: BrokerOrderStatus;
  qty: number;
  filledQty: number;
  avgFillPrice: number | null;
  legs: BrokerLeg[];
}
export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
} // qty is signed: negative = short
export interface BrokerAccount {
  equity: number;
  lastEquity: number;
  buyingPower: number;
  tradingBlocked: boolean;
}
export interface BracketRequest {
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  limitPrice: number;
  stopPrice: number;
  takePrice: number;
}

export class BrokerError extends Error {
  /** rejected/auth = definitively not accepted. ambiguous = may or may not have reached the broker (timeout, 5xx, 429). */
  constructor(
    public kind: "rejected" | "auth" | "ambiguous" | "not_found",
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrokerAdapter {
  readonly name: string;
  readonly mode: BrokerMode;
  getAccount(): Promise<BrokerAccount>;
  /** nextClose is today's close while the market is open (accurate on half-days). */
  getClock(): Promise<{ isOpen: boolean; nextClose: Date | null }>;
  getLastPrice(symbol: string): Promise<{ price: number; ageSec: number }>;
  submitBracketOrder(req: BracketRequest): Promise<{ brokerOrderId: string }>;
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;
  listPositions(): Promise<BrokerPosition[]>;
  /** Cancels an order and its legs. Resolves false if it was already terminal. */
  cancelOrder(brokerOrderId: string): Promise<boolean>;
  /** Market-closes one symbol. Caller must cancel the bracket first (brokers hold the shares against open exit orders). */
  closePosition(symbol: string): Promise<void>;
}
