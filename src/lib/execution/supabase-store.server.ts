// Supabase implementation of the Store ports. Admin client only: users can read their rows but never write them.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendTelegram } from "@/lib/alerts.server";
import type { Patch } from "./state";
import {
  DuplicateOrderError,
  type AutopilotRun,
  type AutopilotStore,
  type EventLog,
  type NewOrder,
  type Store,
} from "./store";
import {
  ACTIVE_STATUSES,
  DEFAULT_SETTINGS,
  type BrokerMode,
  type ExecutionSettings,
  type ExitReason,
  type OrderRow,
  type OrderStatus,
  type SetupRow,
} from "./types";

// The generated Supabase types do not know the new tables until they are regenerated after migration 0011.
// Once types.ts includes orders / execution_settings / execution_events / autopilot_runs, delete this cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

const n = (v: unknown): number | null => (v == null ? null : Number(v));
type Row = Record<string, unknown>;
const toOrder = (r: Row): OrderRow => ({
  id: r["id"] as string,
  userId: r["user_id"] as string,
  setupId: (r["setup_id"] as string) ?? null,
  ticker: r["ticker"] as string,
  side: r["side"] as OrderRow["side"],
  mode: r["mode"] as BrokerMode,
  broker: r["broker"] as string,
  clientOrderId: r["client_order_id"] as string,
  brokerOrderId: (r["broker_order_id"] as string) ?? null,
  status: r["status"] as OrderStatus,
  qty: Number(r["qty"]),
  limitPrice: Number(r["limit_price"]),
  stopPrice: Number(r["stop_price"]),
  takePrice: Number(r["take_price"]),
  filledQty: Number(r["filled_qty"]),
  entryPrice: n(r["entry_price"]),
  exitPrice: n(r["exit_price"]),
  exitReason: (r["exit_reason"] as ExitReason) ?? null,
  exitHint: (r["exit_hint"] as ExitReason) ?? null,
  realizedPnl: n(r["realized_pnl"]),
  statusReason: (r["status_reason"] as string) ?? null,
  expiresAt: (r["expires_at"] as string) ?? null,
  submittedAt: (r["submitted_at"] as string) ?? null,
  openedAt: (r["opened_at"] as string) ?? null,
  closedAt: (r["closed_at"] as string) ?? null,
  version: Number(r["version"]),
  createdAt: r["created_at"] as string,
});
const COLS: Record<keyof Patch, string> = {
  status: "status",
  brokerOrderId: "broker_order_id",
  filledQty: "filled_qty",
  entryPrice: "entry_price",
  exitPrice: "exit_price",
  exitReason: "exit_reason",
  exitHint: "exit_hint",
  realizedPnl: "realized_pnl",
  statusReason: "status_reason",
  submittedAt: "submitted_at",
  openedAt: "opened_at",
  closedAt: "closed_at",
};

export const supabaseStore: Store & AutopilotStore = {
  async getSettings(userId) {
    const [{ data: s }, { data: p }] = await Promise.all([
      db().from("execution_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabaseAdmin
        .from("user_preferences")
        .select("max_open_risk_pct")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
    if (!s) return null;
    const x = s as Row;
    return {
      userId,
      mode: x["mode"] as ExecutionSettings["mode"],
      killSwitch: x["kill_switch"] as boolean,
      liveArmedAt: (x["live_armed_at"] as string) ?? null,
      allowShort: x["allow_short"] as boolean,
      maxOpenPositions: Number(x["max_open_positions"]),
      maxPositionPct: Number(x["max_position_pct"]),
      maxDailyLossPct: Number(x["max_daily_loss_pct"]),
      maxOpenRiskPct:
        p?.max_open_risk_pct != null
          ? Number(p.max_open_risk_pct)
          : DEFAULT_SETTINGS.maxOpenRiskPct,
      minRr: Number(x["min_rr"]),
      maxSetupAgeMin: Number(x["max_setup_age_min"]),
      entryCollarBps: Number(x["entry_collar_bps"]),
      maxHoldMin: Number(x["max_hold_min"]),
      flattenMinBeforeClose: Number(x["flatten_min_before_close"]),
      flattenUnprotected: x["flatten_unprotected"] as boolean,
      entryExpiryBars: Number(x["entry_expiry_bars"]),
      avoidOpenMin: Number(x["avoid_open_min"]),
      maxTradesPerDay: Number(x["max_trades_per_day"]),
      maxConsecutiveLosses: Number(x["max_consecutive_losses"]),
      tickerCooldownMin: Number(x["ticker_cooldown_min"]),
      estCostBps: Number(x["est_cost_bps"]),
      minCostMultiple: Number(x["min_cost_multiple"]),
      autopilotEnabled: x["autopilot_enabled"] as boolean,
      autopilotTimeframe: x["autopilot_timeframe"] as "5m" | "15m",
    };
  },
  async setKillSwitch(userId, on) {
    const { error } = await db()
      .from("execution_settings")
      .update({ kill_switch: on, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
  },
  async getSetup(userId, setupId) {
    const { data } = await supabaseAdmin
      .from("trade_setups")
      .select("*")
      .eq("id", setupId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id,
      userId: data.user_id,
      ticker: data.ticker,
      side: (data.side as SetupRow["side"]) ?? null,
      status: data.status,
      timeframe: data.timeframe,
      createdAt: data.created_at,
      entryZoneLow: n(data.entry_zone_low),
      entryZoneHigh: n(data.entry_zone_high),
      preferredEntry: n(data.preferred_entry),
      stopLoss: n(data.stop_loss),
      takeProfit1: n(data.take_profit_1),
      positionShares: data.position_shares,
      riskPercent: n(data.risk_percent),
      accountSize: n(data.account_size),
    };
  },
  async activeOrders(userId, mode) {
    const { data, error } = await db()
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .eq("mode", mode)
      .in("status", ACTIVE_STATUSES);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[]).map(toOrder);
  },
  async insertOrder(o: NewOrder) {
    const { data, error } = await db()
      .from("orders")
      .insert({
        user_id: o.userId,
        setup_id: o.setupId,
        ticker: o.ticker,
        side: o.side,
        mode: o.mode,
        broker: o.broker,
        client_order_id: o.clientOrderId,
        status: "PENDING",
        qty: o.qty,
        limit_price: o.limitPrice,
        stop_price: o.stopPrice,
        take_price: o.takePrice,
        expires_at: o.expiresAt,
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") throw new DuplicateOrderError();
      throw new Error(error.message);
    }
    return toOrder(data as Row);
  },
  async updateOrder(id, expectedVersion, patch) {
    const set: Row = { version: expectedVersion + 1, updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) set[COLS[k as keyof Patch]] = v;
    const { data, error } = await db()
      .from("orders")
      .update(set)
      .eq("id", id)
      .eq("version", expectedVersion)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toOrder(data as Row) : null; // null = someone else updated first
  },
  async tradesSince(userId, mode, sinceIso) {
    const { count, error } = await db()
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("mode", mode)
      .gte("created_at", sinceIso)
      .not("status", "in", "(REJECTED,CANCELED,EXPIRED)");
    if (error) throw new Error(error.message);
    return count ?? 0;
  },
  async closedSince(userId, mode, sinceIso) {
    const { data, error } = await db()
      .from("orders")
      .select("ticker, realized_pnl, closed_at")
      .eq("user_id", userId)
      .eq("mode", mode)
      .eq("status", "CLOSED")
      .gte("closed_at", sinceIso)
      .order("closed_at", { ascending: false });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[]).map((r) => ({
      ticker: r["ticker"] as string,
      realizedPnl: n(r["realized_pnl"]),
      closedAt: r["closed_at"] as string,
    }));
  },
  async logEvent(e: EventLog) {
    const { error } = await db()
      .from("execution_events")
      .insert({
        user_id: e.userId,
        order_id: e.orderId,
        kind: e.kind,
        from_status: e.fromStatus ?? null,
        to_status: e.toStatus ?? null,
        detail: e.detail ?? {},
      });
    if (error) console.error("execution_events insert failed", error.message);
  },
  async hasRecentEvent(userId, kind, key, withinMin) {
    const since = new Date(Date.now() - withinMin * 60_000).toISOString();
    const { data } = await db()
      .from("execution_events")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", kind)
      .eq("detail->>key", key)
      .gte("created_at", since)
      .limit(1);
    return !!data?.length;
  },
  async notify(userId, text) {
    const { data: pref } = await supabaseAdmin
      .from("user_preferences")
      .select("telegram_enabled, telegram_chat_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (pref?.telegram_enabled && pref.telegram_chat_id)
      await sendTelegram(pref.telegram_chat_id, `TradeMind: ${text}`);
  },
  async reconcileTargets() {
    const [{ data: on }, { data: act }] = await Promise.all([
      db().from("execution_settings").select("user_id, mode").neq("mode", "off"),
      db().from("orders").select("user_id, mode").in("status", ACTIVE_STATUSES),
    ]);
    const seen = new Map<string, { userId: string; mode: BrokerMode }>();
    for (const r of [...((on ?? []) as Row[]), ...((act ?? []) as Row[])])
      seen.set(`${r["user_id"]}:${r["mode"]}`, {
        userId: r["user_id"] as string,
        mode: r["mode"] as BrokerMode,
      });
    return [...seen.values()];
  },

  // ---- autopilot
  async autopilotUsers() {
    const { data } = await db()
      .from("execution_settings")
      .select("user_id")
      .eq("autopilot_enabled", true)
      .neq("mode", "off")
      .eq("kill_switch", false);
    return ((data ?? []) as Row[]).map((r) => r["user_id"] as string);
  },
  async watchlist(userId, timeframe) {
    const { data } = await supabaseAdmin
      .from("watchlist_items")
      .select("ticker")
      .eq("user_id", userId)
      .eq("timeframe", timeframe)
      .order("position", { ascending: true });
    return (data ?? []).map((r) => r.ticker);
  },
  async getRun(userId, barId) {
    const { data } = await db()
      .from("autopilot_runs")
      .select("*")
      .eq("user_id", userId)
      .eq("bar_id", barId)
      .maybeSingle();
    if (!data) return null;
    const r = data as Row;
    return {
      userId,
      barId,
      timeframe: r["timeframe"] as string,
      status: r["status"] as AutopilotRun["status"],
      cursor: Number(r["cursor"]),
      tickersTotal: Number(r["tickers_total"]),
      setupsFound: Number(r["setups_found"]),
      ordersPlaced: Number(r["orders_placed"]),
      skipped: (r["skipped"] as Record<string, string>) ?? {},
      errors: (r["errors"] as string[]) ?? [],
    };
  },
  async saveRun(r) {
    const { error } = await db().from("autopilot_runs").upsert(
      {
        user_id: r.userId,
        bar_id: r.barId,
        timeframe: r.timeframe,
        status: r.status,
        cursor: r.cursor,
        tickers_total: r.tickersTotal,
        setups_found: r.setupsFound,
        orders_placed: r.ordersPlaced,
        skipped: r.skipped,
        errors: r.errors,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,bar_id" },
    );
    if (error) throw new Error(error.message);
  },
};
