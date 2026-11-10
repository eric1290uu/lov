// Execution engine: place bracket orders, reconcile against the broker, kill switch.
// IO is injected (broker + store), so the whole flow runs against a fake broker in tests.
import { BrokerError, type BrokerAdapter, type BrokerPosition } from "./broker";
import { evaluateGate, type GateFailure, type OrderPlan } from "./gate";
import { deriveEvents } from "./reconcile";
import { applyEvent, type OrderEvent } from "./state";
import { DuplicateOrderError, type Store } from "./store";
import { sessionOpenEt, startOfEtDay } from "./time";
import { isActive, type ExitReason, type OrderRow } from "./types";

export type PlaceResult =
  | { ok: true; order: OrderRow; plan: OrderPlan; warning?: string }
  | { ok: false; code: string; message: string; failures?: GateFailure[] };

export interface ReconcileSummary {
  checked: number;
  transitions: number;
  flattened: number;
  canceled: number;
  anomalies: string[];
}
export interface EngineDeps {
  broker: BrokerAdapter;
  store: Store;
  now?: () => Date;
}

export function createEngine({ broker, store, now = () => new Date() }: EngineDeps) {
  const iso = () => now().toISOString();
  const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 6e4;

  /** The only way an order changes status: validate -> optimistic write -> audit log. Returns the new row, or null if skipped. */
  async function advance(order: OrderRow, ev: OrderEvent): Promise<OrderRow | null> {
    const r = applyEvent(order, ev, iso());
    if (!r.ok) {
      await store.logEvent({
        userId: order.userId,
        orderId: order.id,
        kind: "TRANSITION_REJECTED",
        fromStatus: order.status,
        detail: { event: ev, reason: r.reason },
      });
      return null;
    }
    const updated = await store.updateOrder(order.id, order.version, r.patch);
    if (!updated) {
      await store.logEvent({
        userId: order.userId,
        orderId: order.id,
        kind: "VERSION_CONFLICT",
        fromStatus: order.status,
        detail: { event: ev },
      });
      return null;
    }
    await store.logEvent({
      userId: order.userId,
      orderId: order.id,
      kind: ev.type,
      fromStatus: order.status,
      toStatus: updated.status,
      detail: ev,
    });
    return updated;
  }

  async function notifyTransition(o: OrderRow, ev: OrderEvent) {
    const t = `${o.side} ${o.ticker} x${o.qty} [${o.mode}]`;
    if (ev.type === "ENTRY_FILLED")
      await store.notify(
        o.userId,
        `Entered ${t} @ ${ev.avgPrice}. Stop ${o.stopPrice}, target ${o.takePrice}.`,
      );
    else if (ev.type === "EXIT_FILLED")
      await store.notify(
        o.userId,
        `Closed ${t} (${o.exitReason ?? ev.reason}) ${ev.exitPrice != null ? `@ ${ev.exitPrice}` : ""}${o.realizedPnl != null ? `, P&L ${o.realizedPnl}` : ""}`,
      );
    else if (ev.type === "PROTECTION_LOST")
      await store.notify(o.userId, `WARNING: ${t} has no live stop at the broker.`);
    else if (ev.type === "REJECTED" || ev.type === "SUBMIT_FAILED")
      await store.notify(o.userId, `Order not placed: ${t}: ${ev.reason}`);
  }

  async function place(userId: string, setupId: string): Promise<PlaceResult> {
    const settings = await store.getSettings(userId);
    if (!settings)
      return { ok: false, code: "NOT_CONFIGURED", message: "Execution settings not found." };
    if (settings.mode === "off")
      return { ok: false, code: "MODE_OFF", message: "Execution is off." };
    if (settings.mode !== broker.mode)
      return {
        ok: false,
        code: "MODE_MISMATCH",
        message: `Settings are ${settings.mode} but broker is ${broker.mode}.`,
      };
    const setup = await store.getSetup(userId, setupId);
    if (!setup) return { ok: false, code: "SETUP_NOT_FOUND", message: "Setup not found." };

    let ctx;
    try {
      const t = now();
      const dayStart = startOfEtDay(t).toISOString();
      const [account, clock, active, tradesToday, closed] = await Promise.all([
        broker.getAccount(),
        broker.getClock(),
        store.activeOrders(userId, settings.mode),
        store.tradesSince(userId, settings.mode, dayStart),
        store.closedSince(userId, settings.mode, dayStart),
      ]);
      const px = await broker.getLastPrice(setup.ticker).catch(() => null);
      let lossStreakToday = 0;
      for (const c of closed) {
        if (c.realizedPnl == null) continue;
        if (c.realizedPnl < 0) lossStreakToday++;
        else break;
      }
      ctx = {
        now: t,
        equity: account.equity,
        buyingPower: account.buyingPower,
        dayPnl: account.equity - account.lastEquity,
        tradingBlocked: account.tradingBlocked,
        marketOpen: clock.isOpen,
        minutesSinceOpen: clock.isOpen ? minutesBetween(sessionOpenEt(t), t) : null,
        minutesToClose: clock.isOpen && clock.nextClose ? minutesBetween(t, clock.nextClose) : null,
        quote: px?.price ?? null,
        quoteAgeSec: px?.ageSec ?? null,
        active: active.map((a) => ({
          ticker: a.ticker,
          qty: a.filledQty || a.qty,
          entry: a.entryPrice ?? a.limitPrice,
          stop: a.stopPrice,
        })),
        tradesToday,
        lossStreakToday,
        lastLossAtForTicker:
          closed.find(
            (c) => c.ticker === setup.ticker && c.realizedPnl != null && c.realizedPnl < 0,
          )?.closedAt ?? null,
      };
    } catch (e) {
      return {
        ok: false,
        code: "BROKER_UNAVAILABLE",
        message: `Could not read broker state: ${(e as Error).message}`,
      };
    }

    const gate = evaluateGate(settings, setup, ctx);
    if (!gate.ok || !gate.plan || !setup.side) {
      await store.logEvent({
        userId,
        orderId: null,
        kind: "GATE_BLOCKED",
        detail: { setupId, ticker: setup.ticker, failures: gate.failures },
      });
      return {
        ok: false,
        code: "GATE_BLOCKED",
        message: gate.failures.map((f) => f.message).join(" "),
        failures: gate.failures,
      };
    }
    const plan = gate.plan;

    // Write the intent first, with a deterministic client id: a retry, double-click or cron overlap cannot create a second order.
    let order: OrderRow;
    try {
      order = await store.insertOrder({
        userId,
        setupId,
        ticker: setup.ticker,
        side: setup.side,
        mode: broker.mode,
        broker: broker.name,
        clientOrderId: `tm-${broker.mode}-${setupId}`,
        qty: plan.qty,
        limitPrice: plan.limitPrice,
        stopPrice: plan.stopPrice,
        takePrice: plan.takePrice,
        expiresAt: new Date(ctx.now.getTime() + plan.expiresInMin * 60_000).toISOString(),
      });
    } catch (e) {
      if (e instanceof DuplicateOrderError)
        return {
          ok: false,
          code: "DUPLICATE",
          message: "An order for this setup or ticker already exists.",
        };
      throw e;
    }
    await store.logEvent({
      userId,
      orderId: order.id,
      kind: "ORDER_CREATED",
      toStatus: "PENDING",
      detail: plan,
    });

    try {
      const { brokerOrderId } = await broker.submitBracketOrder({
        clientOrderId: order.clientOrderId,
        symbol: order.ticker,
        side: order.side,
        qty: plan.qty,
        limitPrice: plan.limitPrice,
        stopPrice: plan.stopPrice,
        takePrice: plan.takePrice,
      });
      const sent = await advance(order, { type: "SENT", brokerOrderId });
      return { ok: true, order: sent ?? order, plan };
    } catch (e) {
      if (e instanceof BrokerError && (e.kind === "rejected" || e.kind === "auth")) {
        const ev: OrderEvent = { type: "SUBMIT_FAILED", reason: e.message };
        const failed = await advance(order, ev);
        if (failed) await notifyTransition(failed, ev);
        return { ok: false, code: "BROKER_REJECTED", message: e.message };
      }
      // Ambiguous (timeout / 5xx): the order may exist. Look it up by client id instead of guessing, and never resubmit blindly.
      const found = await broker.getOrderByClientId(order.clientOrderId).catch(() => null);
      if (found) {
        const sent = await advance(order, { type: "SENT", brokerOrderId: found.id });
        return { ok: true, order: sent ?? order, plan };
      }
      return {
        ok: true,
        order,
        plan,
        warning:
          "Submit outcome unknown. The order stays PENDING; the next reconcile will resolve it.",
      };
    }
  }

  async function flatten(order: OrderRow, reason: ExitReason): Promise<boolean> {
    // Reconcile runs every minute and a market close takes a moment to fill: do not hammer the broker or spam alerts.
    if (await store.hasRecentEvent(order.userId, "FLATTEN_REQUESTED", order.id, 2)) return true;
    try {
      await store.updateOrder(order.id, order.version, { exitHint: reason });
      await store.logEvent({
        userId: order.userId,
        orderId: order.id,
        kind: "FLATTEN_REQUESTED",
        detail: { key: order.id, reason },
      });
      if (order.brokerOrderId) await broker.cancelOrder(order.brokerOrderId); // releases the shares held against the bracket legs
      await broker.closePosition(order.ticker);
      return true;
    } catch (e) {
      const first = !(await store.hasRecentEvent(order.userId, "FLATTEN_FAILED", order.id, 15));
      await store.logEvent({
        userId: order.userId,
        orderId: order.id,
        kind: "FLATTEN_FAILED",
        detail: { key: order.id, reason, error: (e as Error).message },
      });
      if (first)
        await store.notify(
          order.userId,
          `FAILED to flatten ${order.ticker} (${reason}): ${(e as Error).message}. Check the broker now.`,
        );
      return false;
    }
  }

  async function reconcile(userId: string): Promise<ReconcileSummary> {
    const sum: ReconcileSummary = {
      checked: 0,
      transitions: 0,
      flattened: 0,
      canceled: 0,
      anomalies: [],
    };
    const settings = await store.getSettings(userId);
    if (!settings) return sum;
    const orders = await store.activeOrders(userId, broker.mode);
    const positions: BrokerPosition[] = await broker.listPositions();
    // If the clock call fails we still process fills and stops; we just cannot make time-based decisions this round.
    const clock = await broker.getClock().catch(() => ({ isOpen: true, nextClose: null }));
    const minutesToClose =
      clock.isOpen && clock.nextClose ? minutesBetween(now(), clock.nextClose) : null;

    for (let order of orders) {
      sum.checked++;
      const bo = await broker.getOrderByClientId(order.clientOrderId).catch(() => undefined);
      if (bo === undefined) continue; // broker unreachable for this order: change nothing rather than guess
      const out = deriveEvents({
        order,
        brokerOrder: bo,
        position: positions.find((p) => p.symbol === order.ticker) ?? null,
        now: now(),
        marketOpen: clock.isOpen,
        minutesToClose,
        maxHoldMin: settings.maxHoldMin,
        flattenMinBeforeClose: settings.flattenMinBeforeClose,
        flattenUnprotected: settings.flattenUnprotected,
      });
      for (const a of out.anomalies) {
        sum.anomalies.push(`${order.ticker}: ${a}`);
        if (!(await store.hasRecentEvent(userId, "ANOMALY", `${order.id}:${a}`, 360))) {
          await store.logEvent({
            userId,
            orderId: order.id,
            kind: "ANOMALY",
            detail: { key: `${order.id}:${a}`, anomaly: a },
          });
          await store.notify(userId, `Reconcile anomaly on ${order.ticker}: ${a}`);
        }
      }
      let alive = true;
      for (const ev of out.events) {
        const next = await advance(order, ev);
        if (!next) {
          alive = false;
          break;
        }
        order = next;
        sum.transitions++;
        await notifyTransition(order, ev);
      }
      if (alive && isActive(order.status)) {
        for (const act of out.actions) {
          if (act.type === "FLATTEN") {
            if (await flatten(order, act.reason)) sum.flattened++;
          } else if (order.brokerOrderId) {
            await broker.cancelOrder(order.brokerOrderId).catch(() => false);
            await store.logEvent({
              userId,
              orderId: order.id,
              kind: "ENTRY_CANCEL_REQUESTED",
              detail: { reason: act.reason },
            });
            sum.canceled++;
          }
        }
      }
    }

    // Broker positions we have no order for. Never touched (they may be the user's own holdings), only reported once per 6h.
    const tracked = new Set(orders.map((o) => o.ticker));
    for (const p of positions.filter((p) => !tracked.has(p.symbol))) {
      const key = `orphan:${p.symbol}`;
      if (!(await store.hasRecentEvent(userId, "ORPHAN_POSITION", key, 360))) {
        await store.logEvent({
          userId,
          orderId: null,
          kind: "ORPHAN_POSITION",
          detail: { key, symbol: p.symbol, qty: p.qty },
        });
        sum.anomalies.push(`${p.symbol}: position not opened by TradeMind (ignored)`);
      }
    }
    return sum;
  }

  /** Stops new orders, cancels working entries, flattens ONLY positions TradeMind opened. Other holdings in the account are untouched. */
  async function killSwitch(
    userId: string,
    why = "manual",
  ): Promise<ReconcileSummary & { cancelled: number }> {
    await store.setKillSwitch(userId, true);
    await store.logEvent({ userId, orderId: null, kind: "KILL_SWITCH", detail: { why } });
    let cancelled = 0;
    for (const o of await store.activeOrders(userId, broker.mode)) {
      if (o.status === "PENDING" || o.status === "SUBMITTED") {
        if (o.brokerOrderId) {
          await broker.cancelOrder(o.brokerOrderId).catch(() => false);
          cancelled++;
        }
      } else await flatten(o, "KILL_SWITCH");
    }
    await store.notify(
      userId,
      `Kill switch engaged (${why}). Working orders cancelled, TradeMind positions being closed.`,
    );
    return { ...(await reconcile(userId)), cancelled };
  }

  return { place, reconcile, killSwitch };
}
export type ExecutionEngine = ReturnType<typeof createEngine>;
