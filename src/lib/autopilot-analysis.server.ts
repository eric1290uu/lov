// Deterministic analysis for the autopilot. Reuses buildDeterministicDecision (the same code the analysis page runs), skips both AI
// stages, and persists only READY setups so a 15-minute scan of a watchlist does not fill trade_setups with NO_TRADE rows.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deterministicEventRisk } from "./execution/event-risk";
import type { AnalyzeResult } from "./execution/autopilot";
import type { Timeframe } from "./marketdata.server";
import { CURRENT_MODEL } from "./models";
import { buildDeterministicDecision, buildQuantPackage } from "./pipeline.server";
import { TRADE_SETUP_VERSION } from "./tradesetup";

export async function analyzeForAutopilot(
  userId: string,
  ticker: string,
  timeframe: string,
): Promise<AnalyzeResult> {
  const key = process.env["FINNHUB_API_KEY"];
  if (!key) return { kind: "error", message: "FINNHUB_API_KEY is not configured" };

  const { quant: q } = await buildQuantPackage(ticker, timeframe as Timeframe, key);
  const { data: rs } = await supabaseAdmin
    .from("risk_settings")
    .select("account_size, risk_percent")
    .eq("user_id", userId)
    .maybeSingle();
  const account =
    rs && Number(rs.account_size) > 0 && Number(rs.risk_percent) > 0
      ? { accountSize: Number(rs.account_size), riskPercent: Number(rs.risk_percent) }
      : null;
  const news = deterministicEventRisk(q.nextEarnings?.date, new Date());

  const { price, bias, signal, tradeSetup } = buildDeterministicDecision(q, news, account);
  const tl = tradeSetup.levels;
  if (tradeSetup.status !== "READY" || !tradeSetup.side || !tl)
    return { kind: "none", reason: `${tradeSetup.status}: ${tradeSetup.statusReason}` };

  const tp = (i: number) => tl.targets[i] ?? null;
  const { data, error } = await supabaseAdmin
    .from("trade_setups")
    .insert({
      user_id: userId,
      analysis_id: null,
      ticker: q.ticker,
      timeframe: q.timeframe,
      analysis_version: `${TRADE_SETUP_VERSION}/${CURRENT_MODEL.id}/autopilot`,
      bias,
      side: tradeSetup.side,
      status: tradeSetup.status,
      status_reason: tradeSetup.statusReason,
      price,
      entry_zone_low: tl.entryZoneLow,
      entry_zone_high: tl.entryZoneHigh,
      preferred_entry: tl.preferredEntry,
      stop_loss: tl.stopLoss,
      take_profit_1: tp(0)?.price ?? null,
      take_profit_2: tp(1)?.price ?? null,
      take_profit_3: tp(2)?.price ?? null,
      rr_tp1: tp(0)?.rr ?? null,
      rr_tp2: tp(1)?.rr ?? null,
      rr_tp3: tp(2)?.rr ?? null,
      invalidation: tradeSetup.invalidation
        ? `${tradeSetup.invalidation.condition}. ${tradeSetup.invalidation.reason}`
        : null,
      position_shares: tradeSetup.positionSizing.shares,
      risk_percent: account?.riskPercent ?? null,
      account_size: account?.accountSize ?? null,
      supporting_features: JSON.parse(
        JSON.stringify({
          levels: tl,
          filters: tradeSetup.filters,
          alignmentScore: q.mtf.alignment.alignmentScore,
          regime: q.regime.label,
          eventRisk: news.eventRisk.level,
          signalScore: { long: signal.long.score, short: signal.short.score },
          autopilot: true,
          newsAssessed: false,
        }),
      ),
    })
    .select("id")
    .single();
  if (error || !data) return { kind: "error", message: error?.message ?? "could not save setup" };
  return { kind: "setup", setupId: data.id };
}
