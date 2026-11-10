// Pure order state machine. No IO, no clock (time is passed in). Every change to an order's status goes through
// applyEvent, so illegal jumps (e.g. CLOSED -> OPEN) are impossible by construction and every transition is testable.
import type { ExitReason, OrderRow, OrderStatus } from "./types";

export type OrderEvent =
  | { type: "SENT"; brokerOrderId: string }
  | { type: "SUBMIT_FAILED"; reason: string } // definitive: the broker never took the order
  | { type: "REJECTED"; reason: string } // broker took it, then rejected it
  | { type: "PARTIAL_FILL"; filledQty: number; avgPrice: number }
  | { type: "ENTRY_FILLED"; filledQty: number; avgPrice: number }
  | { type: "ENTRY_CANCELED"; reason: string }
  | { type: "ENTRY_EXPIRED" }
  | { type: "EXIT_FILLED"; reason: ExitReason; exitPrice: number | null }
  | { type: "PROTECTION_LOST"; detail: string }
  | { type: "PROTECTION_RESTORED" };

export type Patch = Partial<
  Pick<
    OrderRow,
    | "status"
    | "brokerOrderId"
    | "filledQty"
    | "entryPrice"
    | "exitPrice"
    | "exitReason"
    | "exitHint"
    | "realizedPnl"
    | "statusReason"
    | "submittedAt"
    | "openedAt"
    | "closedAt"
  >
>;
export type TransitionResult = { ok: true; patch: Patch } | { ok: false; reason: string };
type OrderView = Pick<OrderRow, "status" | "side" | "filledQty" | "entryPrice" | "exitHint">;

// from-status -> event type -> to-status. Anything not listed is illegal.
const ALLOWED: Record<OrderStatus, Partial<Record<OrderEvent["type"], OrderStatus>>> = {
  PENDING: { SENT: "SUBMITTED", SUBMIT_FAILED: "REJECTED", REJECTED: "REJECTED" },
  // A fill and its stop/target can both happen between two polls, so exits are legal from every pre-close state.
  SUBMITTED: {
    PARTIAL_FILL: "PARTIALLY_FILLED",
    ENTRY_FILLED: "OPEN",
    ENTRY_CANCELED: "CANCELED",
    ENTRY_EXPIRED: "EXPIRED",
    REJECTED: "REJECTED",
    EXIT_FILLED: "CLOSED",
  },
  PARTIALLY_FILLED: {
    PARTIAL_FILL: "PARTIALLY_FILLED",
    ENTRY_FILLED: "OPEN",
    ENTRY_CANCELED: "OPEN",
    ENTRY_EXPIRED: "OPEN",
    EXIT_FILLED: "CLOSED",
  },
  OPEN: { PROTECTION_LOST: "NEEDS_ATTENTION", EXIT_FILLED: "CLOSED" },
  NEEDS_ATTENTION: { PROTECTION_RESTORED: "OPEN", EXIT_FILLED: "CLOSED" },
  CLOSED: {},
  CANCELED: {},
  REJECTED: {},
  EXPIRED: {},
};

export const canTransition = (from: OrderStatus, ev: OrderEvent["type"]) =>
  ALLOWED[from][ev] !== undefined;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function applyEvent(o: OrderView, ev: OrderEvent, nowIso: string): TransitionResult {
  const to = ALLOWED[o.status][ev.type];
  if (!to) return { ok: false, reason: `illegal: ${ev.type} while ${o.status}` };
  const patch: Patch = { status: to };

  switch (ev.type) {
    case "SENT":
      patch.brokerOrderId = ev.brokerOrderId;
      patch.submittedAt = nowIso;
      break;
    case "SUBMIT_FAILED":
    case "REJECTED":
      patch.statusReason = ev.reason;
      patch.closedAt = nowIso;
      break;
    case "PARTIAL_FILL":
      if (o.status === "PARTIALLY_FILLED" && ev.filledQty <= o.filledQty)
        return { ok: false, reason: "stale partial fill (quantity did not increase)" };
      patch.filledQty = ev.filledQty;
      patch.entryPrice = ev.avgPrice;
      break;
    case "ENTRY_FILLED":
      patch.filledQty = ev.filledQty;
      patch.entryPrice = ev.avgPrice;
      patch.openedAt = nowIso;
      break;
    case "ENTRY_CANCELED":
      patch.statusReason = ev.reason;
      if (to === "OPEN") patch.openedAt = nowIso;
      else patch.closedAt = nowIso; // remainder of a partial fill was cancelled: the filled part is a live position
      break;
    case "ENTRY_EXPIRED":
      patch.statusReason = "entry order expired";
      if (to === "OPEN") patch.openedAt = nowIso;
      else patch.closedAt = nowIso;
      break;
    case "PROTECTION_LOST":
      patch.statusReason = ev.detail;
      break;
    case "PROTECTION_RESTORED":
      patch.statusReason = null;
      break;
    case "EXIT_FILLED": {
      // An exit we asked for (flatten) shows up at the broker as a plain position close; the hint tells us why.
      patch.exitReason = ev.reason === "MANUAL" && o.exitHint ? o.exitHint : ev.reason;
      patch.exitPrice = ev.exitPrice;
      patch.closedAt = nowIso;
      if (ev.exitPrice != null && o.entryPrice != null && o.filledQty > 0) {
        const sign = o.side === "LONG" ? 1 : -1;
        patch.realizedPnl = round2(sign * (ev.exitPrice - o.entryPrice) * o.filledQty); // gross: broker fees are not included
      }
      break;
    }
  }
  return { ok: true, patch };
}
