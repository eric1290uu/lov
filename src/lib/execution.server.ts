// Wires the engine to Alpaca + Supabase. Everything the UI and cron call goes through here.
import { AlpacaBroker } from "./execution/alpaca.server";
import { createAutopilot } from "./execution/autopilot";
import { createEngine } from "./execution/engine";
import { supabaseStore } from "./execution/supabase-store.server";
import type { BrokerMode, SettingsPatch } from "./execution/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { analyzeForAutopilot } from "./autopilot-analysis.server";

const engineFor = (mode: BrokerMode) =>
  createEngine({ broker: new AlpacaBroker(mode), store: supabaseStore });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

export async function placeSetupOrder(userId: string, setupId: string) {
  const s = await supabaseStore.getSettings(userId);
  if (!s || s.mode === "off")
    return { ok: false as const, code: "MODE_OFF", message: "Execution is off." };
  try {
    return await engineFor(s.mode).place(userId, setupId);
  } catch (e) {
    return { ok: false as const, code: "ENGINE_ERROR", message: (e as Error).message };
  }
}

export async function reconcileAll() {
  const targets = await supabaseStore.reconcileTargets();
  const results: {
    userId: string;
    mode: BrokerMode;
    ok: boolean;
    checked?: number;
    transitions?: number;
    flattened?: number;
    error?: string;
  }[] = [];
  for (const t of targets) {
    try {
      const r = await engineFor(t.mode).reconcile(t.userId);
      results.push({
        userId: t.userId,
        mode: t.mode,
        ok: true,
        checked: r.checked,
        transitions: r.transitions,
        flattened: r.flattened,
      });
    } catch (e) {
      console.error("reconcile failed", t.userId, t.mode, e);
      await supabaseStore.logEvent({
        userId: t.userId,
        orderId: null,
        kind: "RECONCILE_FAILED",
        detail: { error: (e as Error).message },
      });
      results.push({ userId: t.userId, mode: t.mode, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

/** Autopilot for every user who has it on. Live additionally needs ALPACA_ALLOW_AUTOPILOT_LIVE=1: unattended real-money trading is its own deliberate switch. */
export async function autopilotAll() {
  const out: { userId: string; result?: unknown; error?: string }[] = [];
  for (const userId of await supabaseStore.autopilotUsers()) {
    try {
      const s = await supabaseStore.getSettings(userId);
      if (!s || s.mode === "off") continue;
      if (s.mode === "live" && process.env["ALPACA_ALLOW_AUTOPILOT_LIVE"] !== "1") {
        out.push({ userId, result: { ran: false, reason: "autopilot_live_locked" } });
        continue;
      }
      const broker = new AlpacaBroker(s.mode);
      const ap = createAutopilot({
        engine: createEngine({ broker, store: supabaseStore }),
        store: supabaseStore,
        broker,
        analyze: analyzeForAutopilot,
      });
      out.push({ userId, result: await ap.tick(userId) });
    } catch (e) {
      console.error("autopilot failed", userId, e);
      out.push({ userId, error: (e as Error).message });
    }
  }
  return out;
}

/** One cron tick (every minute): reconcile first so exits and flattens are current, then let the autopilot look for entries. */
export async function tickAll() {
  const reconciled = await reconcileAll();
  const autopilot = await autopilotAll();
  return { reconciled, autopilot };
}

export async function engageKillSwitch(userId: string, why: string) {
  const modes: BrokerMode[] = ["paper", "live"];
  await supabaseStore.setKillSwitch(userId, true); // stops new orders even if the broker calls below fail
  const out = [];
  for (const m of modes) {
    if ((await supabaseStore.activeOrders(userId, m)).length === 0) continue;
    try {
      out.push({ mode: m, ...(await engineFor(m).killSwitch(userId, why)) });
    } catch (e) {
      out.push({ mode: m, error: (e as Error).message });
    }
  }
  return out;
}

export async function saveSettings(userId: string, p: SettingsPatch) {
  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  const map: Record<string, string> = {
    mode: "mode",
    allowShort: "allow_short",
    maxOpenPositions: "max_open_positions",
    maxPositionPct: "max_position_pct",
    maxDailyLossPct: "max_daily_loss_pct",
    minRr: "min_rr",
    maxSetupAgeMin: "max_setup_age_min",
    entryCollarBps: "entry_collar_bps",
    maxHoldMin: "max_hold_min",
    flattenMinBeforeClose: "flatten_min_before_close",
    flattenUnprotected: "flatten_unprotected",
    entryExpiryBars: "entry_expiry_bars",
    avoidOpenMin: "avoid_open_min",
    maxTradesPerDay: "max_trades_per_day",
    maxConsecutiveLosses: "max_consecutive_losses",
    tickerCooldownMin: "ticker_cooldown_min",
    estCostBps: "est_cost_bps",
    minCostMultiple: "min_cost_multiple",
    autopilotEnabled: "autopilot_enabled",
    autopilotTimeframe: "autopilot_timeframe",
  };
  for (const [k, v] of Object.entries(p)) if (v !== undefined && map[k]) row[map[k]] = v;
  const { error } = await db().from("execution_settings").upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}

/** Live is a separate, deliberate step: it only succeeds with server-side unlock + keys, and expires after 24h. */
export async function armLive(userId: string) {
  new AlpacaBroker("live"); // throws if ALPACA_ALLOW_LIVE / live keys are missing
  const { error } = await db().from("execution_settings").upsert(
    {
      user_id: userId,
      mode: "live",
      kill_switch: false,
      live_armed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(error.message);
}

export async function resume(userId: string) {
  await supabaseStore.setKillSwitch(userId, false);
}
