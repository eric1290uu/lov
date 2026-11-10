// Pure reconcile: (our order, the broker's view, the clock) -> events for the state machine + actions for the engine.
// Stops live at the broker and we verify they still exist; intraday rules (entry expiry, EOD flatten, max hold) live here too.
import type { BrokerOrder, BrokerPosition } from "./broker";
import type { OrderEvent } from "./state";
import type { ExitReason, OrderRow, OrderStatus } from "./types";

export interface ReconcileInput {
  order: Pick<OrderRow, "status" | "filledQty" | "openedAt" | "createdAt" | "expiresAt">;
  brokerOrder: BrokerOrder | null;
  position: BrokerPosition | null;
  now: Date;
  marketOpen: boolean;
  minutesToClose: number | null;
  maxHoldMin: number;
  flattenMinBeforeClose: number;
  flattenUnprotected: boolean;
  pendingGraceSec?: number;
}
export type ReconcileAction =
  { type: "FLATTEN"; reason: ExitReason } | { type: "CANCEL_ENTRY"; reason: string };
export interface ReconcileOutput {
  events: OrderEvent[];
  actions: ReconcileAction[];
  anomalies: string[];
}

export function deriveEvents(i: ReconcileInput): ReconcileOutput {
  const out: ReconcileOutput = { events: [], actions: [], anomalies: [] };
  const { order: o, brokerOrder: b, position } = i;
  const grace = i.pendingGraceSec ?? 120;

  if (!b) {
    if (o.status === "PENDING") {
      if ((i.now.getTime() - new Date(o.createdAt).getTime()) / 1000 > grace)
        out.events.push({ type: "SUBMIT_FAILED", reason: "order never reached the broker" });
    } else out.anomalies.push("ORDER_MISSING_AT_BROKER");
    return out;
  }

  let status: OrderStatus = o.status;
  let filled = o.filledQty;
  const push = (e: OrderEvent, next: OrderStatus) => {
    out.events.push(e);
    status = next;
  };
  const closing =
    i.marketOpen && i.minutesToClose != null && i.minutesToClose <= i.flattenMinBeforeClose;

  if (status === "PENDING") push({ type: "SENT", brokerOrderId: b.id }, "SUBMITTED");

  // ---- entry progress
  if (status === "SUBMITTED" || status === "PARTIALLY_FILLED") {
    const avg = b.avgFillPrice ?? 0;
    if (b.status === "filled") {
      push({ type: "ENTRY_FILLED", filledQty: b.filledQty, avgPrice: avg }, "OPEN");
      filled = b.filledQty;
    } else {
      if (b.filledQty > filled) {
        push({ type: "PARTIAL_FILL", filledQty: b.filledQty, avgPrice: avg }, "PARTIALLY_FILLED");
        filled = b.filledQty;
      }
      if (b.status === "canceled")
        push(
          { type: "ENTRY_CANCELED", reason: "entry order canceled at broker" },
          filled > 0 ? "OPEN" : "CANCELED",
        );
      else if (b.status === "expired")
        push({ type: "ENTRY_EXPIRED" }, filled > 0 ? "OPEN" : "EXPIRED");
      else if (b.status === "rejected")
        push({ type: "REJECTED", reason: "rejected by broker" }, "REJECTED");
    }
  }
  if (status === "CANCELED" || status === "EXPIRED" || status === "REJECTED") return out;
  if (status === "SUBMITTED" || status === "PARTIALLY_FILLED") {
    // A stale entry is cancelled rather than left to fill at a price the setup no longer justifies; nothing rests into the close.
    const expired = o.expiresAt != null && i.now.getTime() >= new Date(o.expiresAt).getTime();
    if (expired || closing)
      out.actions.push({
        type: "CANCEL_ENTRY",
        reason: closing ? "approaching the close" : "entry not filled within its window",
      });
    return out;
  }

  // ---- position is live (OPEN / NEEDS_ATTENTION): did it exit, and is it still protected?
  const stop = b.legs.find((l) => l.kind === "stop");
  const take = b.legs.find((l) => l.kind === "take");
  const stopActive = stop?.status === "working";
  const takeActive = take?.status === "working";

  if (take?.status === "filled") {
    push({ type: "EXIT_FILLED", reason: "TARGET", exitPrice: take.avgFillPrice }, "CLOSED");
    return out;
  }
  if (stop?.status === "filled") {
    push({ type: "EXIT_FILLED", reason: "STOP", exitPrice: stop.avgFillPrice }, "CLOSED");
    return out;
  }
  // Position gone with both legs inactive: closed by us (flatten) or by hand at the broker. Never infer this while a leg is still live.
  if (!position && !stopActive && !takeActive) {
    push({ type: "EXIT_FILLED", reason: "MANUAL", exitPrice: null }, "CLOSED");
    return out;
  }

  if (status === "OPEN" && !stopActive)
    push(
      { type: "PROTECTION_LOST", detail: "no live stop order at the broker for an open position" },
      "NEEDS_ATTENTION",
    );
  else if (status === "NEEDS_ATTENTION" && stopActive)
    push({ type: "PROTECTION_RESTORED" }, "OPEN");

  if (position && Math.abs(position.qty) !== filled)
    out.anomalies.push(`QTY_MISMATCH local=${filled} broker=${Math.abs(position.qty)}`);

  // Outside the session a close order would just queue for the next open: alert loudly instead of acting blindly.
  if (!i.marketOpen) {
    out.anomalies.push("POSITION_HELD_OUTSIDE_SESSION");
    return out;
  }

  const heldMin = o.openedAt ? (i.now.getTime() - new Date(o.openedAt).getTime()) / 6e4 : 0;
  if (status === "NEEDS_ATTENTION" && i.flattenUnprotected)
    out.actions.push({ type: "FLATTEN", reason: "UNPROTECTED" });
  else if (closing) out.actions.push({ type: "FLATTEN", reason: "EOD" });
  else if (heldMin >= i.maxHoldMin) out.actions.push({ type: "FLATTEN", reason: "TIME" });
  return out;
}
