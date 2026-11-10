// Server-only staged analysis pipeline.
// Market data → data quality → quant features → structure → regime → multi-timeframe →
// patterns → historical analogs → expectancy → news/events → AI analyst → signal → risk → setup.
// Stage outputs are persisted on the user's `analyses` row so stages can run as separate
// requests (progress shown in the UI) without trusting client-supplied data.
import type { Bar } from "./ta";
import { confidenceTier, LIVE_SCORE_CALIBRATED } from "./models";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { fetchMarketData, computeIndicators } from "./market.server";
import { createDefaultProvider } from "./providers.server";
import { analyzeMultiTimeframe } from "./mtf.server";
import { analyzeNews, type NewsIntelligence } from "./news.server";
import { runAnalyst, MIN_RISK_REWARD, MIN_ALIGNED_FACTORS } from "./analyst.server";
import { decide, deriveBias, deterministicStances, MIN_SIGNAL_SCORE } from "./decision.server";
import { constructTrade, gateFailuresFrom, resolveTradeSetup, TRADE_SETUP_VERSION, type TradeInput } from "./tradesetup";
import { assessDataQuality } from "./dataquality";
import { computeQuantFeatures } from "./features";
import { analyzeStructure } from "./structure";
import { classifyRegime, sectorEtfFor } from "./regime";
import { findAnalogs, findPooledAnalogs, computeExpectancy, ANALOG_HORIZONS } from "./analogs";
import { sectorOf, SECTOR_ETF, DEFAULT_UNIVERSE } from "./backtest-universe";
import { buildRiskPlan } from "./risk";
import { scoreSignal } from "./signal";
import { timeframeSeconds, barsPerYear, type Timeframe } from "./marketdata.server";
import { CURRENT_MODEL } from "./models";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyNumericClaims } from "./claims";

type Sb = SupabaseClient<Database>;
const j = <T,>(x: T): any => JSON.parse(JSON.stringify(x));

export class PipelineError extends Error {}

function marketError(e: unknown, ticker: string): never {
  const kind = (e as { kind?: string }).kind;
  if (kind === "not_found") throw new PipelineError(`No market data found for ${ticker}. Check the ticker symbol.`);
  if (kind === "rate_limited") throw new PipelineError("Market data rate limit reached. Please wait a minute and try again.");
  throw new PipelineError(`Market data is temporarily unavailable for ${ticker}. Please try again shortly.`);
}

// Pooled sector analogs: own + up to 5 peers from the same sector (real daily candles, cached provider).
async function pooledSectorAnalogs(ticker: string, bars: Bar[], sectorEtf: string | null, provider: ReturnType<typeof createDefaultProvider>) {
  const sector = sectorOf(ticker) ?? Object.entries(SECTOR_ETF).find(([, e]) => e === sectorEtf)?.[0] ?? null;
  if (!sector) return { status: "unavailable" as const, reason: "Sector unknown — no peer group" };
  const peers = (DEFAULT_UNIVERSE[sector] ?? []).filter((t) => t !== ticker).slice(0, 5);
  const got = await Promise.allSettled(peers.map((t) => provider.getHistoricalCandles(t, "1d")));
  const peerBars = got.flatMap((r, i) => (r.status === "fulfilled" && r.value.completedCandles.length ? [{ ticker: peers[i]!, bars: r.value.completedCandles }] : []));
  return { sector, ...findPooledAnalogs({ ticker, bars }, peerBars, { horizon: 10 }) };
}

// ---------------- Stage 1: quantitative engines ----------------
export async function buildQuantPackage(ticker: string, timeframe: Timeframe, finnhubKey: string) {
  const provider = createDefaultProvider(finnhubKey);
  let market, mtf;
  try {
    [market, mtf] = await Promise.all([fetchMarketData(ticker, finnhubKey, timeframe, provider), analyzeMultiTimeframe(ticker, timeframe)]);
  } catch (e) {
    marketError(e, ticker);
  }
  if (!market.quote) throw new PipelineError(`No current price available for ${ticker}. Analysis aborted.`);

  const completed = market.completedCandles;
  const quality = assessDataQuality({
    bars: completed,
    timeframeSeconds: timeframeSeconds(timeframe),
    raw: market.rawStats,
    formingBarExcluded: !market.lastBarComplete,
    session: market.session,
    stale: market.stale,
  });
  if (completed.length < 30) {
    throw new PipelineError(`Not enough ${timeframe} price history for ${ticker} (${completed.length} completed bars). Try another timeframe.`);
  }

  // Regime inputs: stock daily, SPY, sector ETF (parallel, cached)
  const daily = mtf.completed["1d"] ?? null;
  const sectorSymbol = sectorEtfFor(market.profile?.industry ?? null);
  const [spyR, secR] = await Promise.allSettled([
    provider.getHistoricalCandles("SPY", "1d"),
    sectorSymbol ? provider.getHistoricalCandles(sectorSymbol, "1d") : Promise.resolve(null),
  ]);
  const regime = classifyRegime({
    stockDaily: daily,
    spyDaily: spyR.status === "fulfilled" ? spyR.value.completedCandles : null,
    sectorDaily: secR.status === "fulfilled" && secR.value ? secR.value.completedCandles : null,
    sectorSymbol,
  });

  const last252 = daily && daily.length >= 200 ? daily.slice(-252) : null;
  const week52 = last252
    ? { high: Math.max(...last252.map((b) => b.high)), low: Math.min(...last252.map((b) => b.low)), source: "daily_candles" as const }
    : market.fundamentals?.week52High && market.fundamentals?.week52Low
      ? { high: market.fundamentals.week52High, low: market.fundamentals.week52Low, source: "fundamentals" as const }
      : null;

  const features = computeQuantFeatures({ bars: completed, barsPerYear: barsPerYear(timeframe), vwap: market.vwap?.vwap ?? null, week52 });
  // Single source of truth: every engine uses completed candles (forming bar excluded).
  const indicators = computeIndicators(completed, market.vwap?.vwap ?? null, timeframe);
  const structure = analyzeStructure(completed);
  const analogs = findAnalogs(completed);
  const statistics = ANALOG_HORIZONS.map((h) => computeExpectancy(analogs.outcomes.get(h) ?? [], h));
  const { outcomes: _drop, ...analogSummary } = analogs;
  void _drop;
  const pooledAnalogs = timeframe === "1d" ? await pooledSectorAnalogs(market.ticker, completed, sectorSymbol, provider) : null;

  const quant = {
    ticker: market.ticker,
    companyName: market.companyName,
    timeframe,
    timestamp: new Date().toISOString(),
    session: market.session,
    quote: market.quote,
    profile: market.profile,
    fundamentals: market.fundamentals,
    insider: market.insider,
    news: market.news,
    nextEarnings: market.nextEarnings,
    earningsCalendarAvailable: market.earningsCalendarAvailable,
    vwap: market.vwap,
    errors: market.errors,
    dataQuality: quality,
    features,
    indicators: { ...indicators, ema20Series: undefined, ema50Series: undefined },
    structure,
    regime,
    mtf: { selected: mtf.selected, selectedReport: mtf.selectedReport, timeframes: mtf.timeframes, alignment: mtf.alignment },
    analogs: analogSummary,
    pooledAnalogs,
    statistics,
  };
  return { quant, chart: { candles: market.candles, ema20: indicators.ema20Series, ema50: indicators.ema50Series } };
}
export type QuantPackage = Awaited<ReturnType<typeof buildQuantPackage>>["quant"];
type InsiderSummary = ReturnType<typeof summarizeInsider>;
interface StageData { quant: QuantPackage; news?: NewsIntelligence; insider?: InsiderSummary }

export async function runQuantStage(sb: Sb, userId: string, ticker: string, timeframe: Timeframe, finnhubKey: string) {
  const { quant, chart } = await buildQuantPackage(ticker, timeframe, finnhubKey);
  const { regime, dataQuality: quality, mtf, analogs: analogSummary } = quant;
  void sb; // writes go through the server-only client: users have no INSERT/UPDATE rights, so results cannot be tampered with.
  const { data: row, error } = await supabaseAdmin
    .from("analyses")
    .insert({ user_id: userId, ticker: quant.ticker, timeframe, status: "quant", signal: "PENDING", confidence: 0, result: {}, stage_data: j({ quant }) })
    .select("id")
    .single();
  if (error) throw new PipelineError(error.message);

  return {
    id: row.id,
    chart,
    preview: { ticker: quant.ticker, dataQuality: quality.status, regime: regime.label, alignmentScore: mtf.alignment.alignmentScore, analogs: analogSummary.similarSetups },
  };
}

async function loadStage(sb: Sb, id: string, expectedStatus: string) {
  // Read through the user's own client: RLS guarantees the row belongs to the caller.
  const { data, error } = await sb.from("analyses").select("id, status, stage_data").eq("id", id).maybeSingle();
  if (error || !data) throw new PipelineError("Analysis not found.");
  if (data.status !== expectedStatus) throw new PipelineError("This analysis stage has already run or is out of order. Please start a new analysis.");
  return data as unknown as { id: string; status: string; stage_data: StageData | null };
}

// ---------------- Stage 2: news + events ----------------
export async function runNewsStage(sb: Sb, userId: string, id: string, aiKey: string) {
  const row = await loadStage(sb, id, "quant");
  const q = row.stage_data?.quant;
  if (!q) throw new PipelineError("Analysis is missing its market data stage.");
  const news = await analyzeNews({ ticker: q.ticker, companyName: q.companyName, news: q.news, nextEarnings: q.nextEarnings, apiKey: aiKey });
  const insider = summarizeInsider(q.insider);
  const { error } = await supabaseAdmin.from("analyses").update({ status: "news", stage_data: j({ ...row.stage_data, news, insider }) }).eq("id", id).eq("user_id", userId);
  if (error) throw new PipelineError(error.message);
  return { ok: true, eventRisk: news.eventRisk.level };
}

function summarizeInsider(tx: { change: number; transactionDate: string; transactionCode: string }[] | null) {
  if (!tx) return { status: "unavailable" as const };
  const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const recent = tx.filter((t) => t.transactionDate >= since && (t.transactionCode === "P" || t.transactionCode === "S"));
  const bought = recent.filter((t) => t.transactionCode === "P").reduce((s, t) => s + Math.abs(t.change), 0);
  const sold = recent.filter((t) => t.transactionCode === "S").reduce((s, t) => s + Math.abs(t.change), 0);
  return { status: "ok" as const, windowDays: 90, openMarketBuys: recent.filter((t) => t.transactionCode === "P").length, openMarketSells: recent.filter((t) => t.transactionCode === "S").length, sharesBought: bought, sharesSold: sold };
}

type DecisionAccount = { accountSize: number; riskPercent: number } | null;

/**
 * The deterministic half of the decision stage: signal score, risk plan, trade construction, quality gates and setup status.
 * Extracted verbatim from runDecisionStage so the analysis page and the autopilot run exactly the same logic. No AI, no IO.
 */
export function buildDeterministicDecision(q: QuantPackage, news: Pick<NewsIntelligence, "eventRisk" | "netSentiment">, account: DecisionAccount) {
  const accountSize = account?.accountSize ?? 0;
  const riskPercent = account?.riskPercent ?? 0;
  const price: number = q.quote.current;
  const ta = q.indicators.ta;
  const atr: number | null = q.features.volatility.atr14 ?? ta.indicators.atr14;
  const supports = ta.levels.support.map((l) => l.price);
  const resistances = ta.levels.resistance.map((l) => l.price);
  const exp5 = q.statistics.find((s) => s.horizon === 5)!;
  const chart = q.mtf.selectedReport?.chartPatterns ?? [];
  const target = (dir: string) => chart.filter((c) => c.direction === dir && c.target != null).sort((a, b) => b.confidence - a.confidence)[0]?.target ?? null;
  const ok = exp5 && exp5.statisticalConfidence !== "insufficient";
  const plans = {
    LONG: buildRiskPlan({ side: "LONG", price, atr, supports, resistances, analogAdverseExcursionPct: ok && exp5.avgMaePct != null ? Math.abs(exp5.avgMaePct) : null, patternTarget: target("bullish"), accountSize, riskPercent }),
    SHORT: buildRiskPlan({ side: "SHORT", price, atr, supports, resistances, analogAdverseExcursionPct: ok && exp5.avgMfePct != null ? Math.abs(exp5.avgMfePct) : null, patternTarget: target("bearish"), accountSize, riskPercent }),
  };

  const signal = scoreSignal({
    features: q.features,
    emaAlignment: ta.trend.emaAlignment,
    trendDirection: ta.trend.direction,
    structure: q.structure,
    mtf: { dominantDirection: q.mtf.alignment.dominantDirection, alignmentScore: q.mtf.alignment.alignmentScore },
    expectancy: exp5,
    regime: q.regime,
    eventRisk: news.eventRisk.level,
    newsSentiment: news.netSentiment.label,
    plans,
  });

  const levelsOf = (p: typeof plans.LONG) => (p ? { entryMid: p.entry, stop: p.stopLoss, tp1: p.takeProfit1 } : null);
  const decisionCtx = { price, ta, patterns: q.mtf.selectedReport, alignment: q.mtf.alignment, eventRisk: news.eventRisk.level, factorStances: deterministicStances(signal.long, signal.short) };

  // Trade construction: bias → entry zone → structural stop → targets (deterministic).
  const bias = deriveBias(decisionCtx);
  const longSide = bias !== "bearish";
  const bo = q.structure?.breakOfStructure ?? null;
  const tradeInput: TradeInput = {
    bias,
    price,
    atr,
    supports: ta.levels.support.map((l) => ({ price: l.price, touches: l.touches })),
    resistances: ta.levels.resistance.map((l) => ({ price: l.price, touches: l.touches })),
    swingHighs: (q.structure?.swingHighs ?? []).map((s) => s.price),
    swingLows: (q.structure?.swingLows ?? []).map((s) => s.price),
    breakout: bo ? { direction: bo.direction, level: q.structure?.retest?.level ?? bo.level, retestHeld: q.structure?.retest ? q.structure.retest.held : null } : null,
    movingAverages: { ema20: q.features.trend.ema20, ema50: q.features.trend.ema50, sma200: q.features.trend.sma200 },
    vwap: q.features.volume.vwap,
    analogMaePct: ok ? (longSide ? exp5.avgMaePct : exp5.avgMfePct) != null ? Math.abs((longSide ? exp5.avgMaePct : exp5.avgMfePct)!) : null : null,
    analogMfePct: ok ? (longSide ? exp5.avgMfePct : exp5.avgMaePct) != null ? Math.abs((longSide ? exp5.avgMfePct : exp5.avgMaePct)!) : null : null,
    patternTarget: target(longSide ? "bullish" : "bearish"),
    account,
  };
  const construction = constructTrade(tradeInput);
  const cl = construction.levels;
  const builtLevels = cl ? { entryMid: cl.preferredEntry, stop: cl.stopLoss, tp1: cl.targets[0]!.price } : null;

  // Deterministic quality gates — evaluated at the constructed preferred entry, BEFORE the AI runs.
  const engine = decide(
    decisionCtx,
    {
      LONG: cl?.side === "LONG" ? builtLevels : levelsOf(plans.LONG),
      SHORT: cl?.side === "SHORT" ? builtLevels : levelsOf(plans.SHORT),
    },
    {
      dataQuality: q.dataQuality.status,
      dataWarnings: q.dataQuality.warnings,
      signalScore: { LONG: signal.long.score, SHORT: signal.short.score },
      expectancy: { sampleSize: exp5.sampleSize, statisticalConfidence: exp5.statisticalConfidence, expectedValuePct: exp5.expectedValuePct },
      volatilityPercentile: q.features.volatility.volatilityPercentile,
      adx: q.features.trend.adx14,
      regimeDirection: q.regime.direction,
    },
  );

  // Location-specific checks (levels / R:R) are owned by the trade construction engine.
  const gateFailures = gateFailuresFrom(engine.sideEvaluation.checks);
  const tradeSetup = resolveTradeSetup(tradeInput, construction, gateFailures);
  return { price, ta, atr, supports, resistances, exp5, plans, signal, bias, tradeInput, construction, engine, gateFailures, tradeSetup };
}

// ---------------- Stage 3: AI analyst + signal + risk + setup ----------------
export async function runDecisionStage(sb: Sb, userId: string, id: string, aiKey: string) {
  const row = await loadStage(sb, id, "news");
  const q = row.stage_data?.quant;
  const news = row.stage_data?.news;
  if (!q || !news) throw new PipelineError("Analysis stages are incomplete. Please run it again.");

  const { data: settings } = await sb.from("risk_settings").select("account_size, risk_percent").eq("user_id", userId).maybeSingle();
  // No configured account → position sizing is reported as unavailable, never assumed.
  const account = settings && Number(settings.account_size) > 0 && Number(settings.risk_percent) > 0
    ? { accountSize: Number(settings.account_size), riskPercent: Number(settings.risk_percent) } : null;
  const accountSize = account?.accountSize ?? 0;
  const riskPercent = account?.riskPercent ?? 0;

  const { price, ta, atr, supports, resistances, exp5, plans, signal, bias, tradeInput, engine, gateFailures, tradeSetup } = buildDeterministicDecision(q, news, account);
  const finalSignal: "LONG" | "SHORT" | "NO_TRADE" = tradeSetup.status === "READY" && tradeSetup.side ? tradeSetup.side : "NO_TRADE";
  const tl = tradeSetup.levels;
  const tp = (i: number) => tl?.targets[i] ?? null;
  const biasLabel = bias === "bullish" ? "Bullish" : bias === "bearish" ? "Bearish" : "Neutral";
  const headline = tradeSetup.status === "READY"
    ? `${biasLabel} bias — ${tradeSetup.side} setup READY: price is in the entry zone.`
    : tradeSetup.status === "WAITING_FOR_ENTRY"
      ? `${biasLabel} bias — WAITING FOR ENTRY: ${tradeSetup.statusReason}.`
      : `${biasLabel} bias — NO TRADE: ${tradeSetup.statusReason}.`;

  // Analysis package for the AI — summarized, no raw candle arrays.
  const aiPayload = {
    ticker: q.ticker,
    companyName: q.companyName,
    timeframe: q.timeframe,
    marketSession: q.session,
    quote: q.quote,
    dataQuality: q.dataQuality,
    quantFeatures: q.features,
    technicalAnalysis: { structure: ta.structure, trend: ta.trend, levels: ta.levels, events: ta.events, bollinger: ta.indicators.bollinger },
    marketStructure: q.structure,
    marketRegime: q.regime,
    multiTimeframe: { alignment: q.mtf.alignment, timeframes: q.mtf.timeframes },
    patternAnalysis: q.mtf.selectedReport
      ? { candlestickPatterns: q.mtf.selectedReport.candlestickPatterns, chartPatterns: q.mtf.selectedReport.chartPatterns, shapeSimilarity: q.mtf.selectedReport.similarity }
      : "insufficient_data",
    historicalAnalogs: q.analogs,
    statisticalExpectancy: q.statistics,
    newsIntelligence: {
      status: news.status,
      netSentiment: news.netSentiment,
      eventRisk: news.eventRisk,
      scheduledEvents: news.scheduledEvents,
      materialEvents: news.materialEvents.map((n) => ({ headline: n.headline, category: n.category, sentiment: n.sentiment, horizon: n.horizon, publishedAt: n.publishedAt })),
      otherRelevant: news.articles.filter((n) => n.impact !== "high").slice(0, 6).map((n) => ({ headline: n.headline, category: n.category, sentiment: n.sentiment, impact: n.impact })),
      insiderActivity: row.stage_data!.insider ?? { status: "unavailable" as const },
      economicCalendar: "unavailable",
    },
    signalEngine: { long: signal.long, short: signal.short, minScoreForTrade: MIN_SIGNAL_SCORE },
    riskEngine: plans,
    tradeSetup: {
      note: "Deterministic trade construction. Every level, R:R and size below is final; explain it, never change it.",
      status: tradeSetup.status, statusReason: tradeSetup.statusReason, side: tradeSetup.side, levels: tl,
      invalidation: tradeSetup.invalidation, positionSizing: tradeSetup.positionSizing, filters: tradeSetup.filters,
    },
    finalDecision: {
      note: "Deterministic and final. Explain it; do not propose a different trade.",
      decision: finalSignal, tradeStatus: tradeSetup.status, evaluatedSide: engine.evaluatedSide, bias: engine.bias, setupStrength: engine.setupStrength,
      signalScore: engine.confidence, checks: engine.sideEvaluation.checks, factorStances: deterministicStances(signal.long, signal.short),
    },
    unavailableData: q.errors,
  };

  const rawAnalyst = await runAnalyst(aiPayload, aiKey);
  // Anti-hallucination: any sentence citing a number not present in the input package is removed.
  const { output: analyst, check: claimCheck } = verifyNumericClaims(rawAnalyst, aiPayload, ["signal", "bias", "stance", "direction", "timeframe"]);

  const d = analyst.decision;
  const isTrade = finalSignal !== "NO_TRADE";
  const clean = (xs: string[]) => xs.filter((x) => typeof x === "string" && x.trim()).slice(0, 6);
  const sideScore = engine.evaluatedSide === "LONG" ? signal.long : signal.short;

  const setup = {
    signal: finalSignal,
    tradeStatus: tradeSetup.status,
    bias,
    biasSummary: d.biasSummary,
    headline,
    setupStrength: engine.setupStrength,
    confidence: engine.confidence,
    signalQuality: confidenceTier(engine.confidence, LIVE_SCORE_CALIBRATED).tier,
    confidenceLabel: confidenceTier(engine.confidence, LIVE_SCORE_CALIBRATED).label,
    entryZoneLow: tl?.entryZoneLow ?? null,
    entryZoneHigh: tl?.entryZoneHigh ?? null,
    stopLoss: tl?.stopLoss ?? null,
    takeProfit1: tp(0)?.price ?? null,
    takeProfit2: tp(1)?.price ?? null,
    takeProfit3: tp(2)?.price ?? null,
    timeframe: d.timeframe || q.timeframe,
    bullishFactors: clean(d.reasonsFor),
    bearishFactors: clean(d.reasonsAgainst),
    risks: clean(d.risks),
    invalidationConditions: clean(d.invalidationConditions),
    explanation: d.explanation,
    blockers: tradeSetup.status === "NO_TRADE" ? tradeSetup.filters.filter((f) => !f.pass).map((f) => ({ type: f.id, label: f.label, detail: f.detail })) : [],
    triggers: isTrade ? [] : d.triggers.slice(0, 3).map((t) => ({ ...t, conditions: clean(t.conditions) })),
    checklist: { side: engine.evaluatedSide, checks: engine.sideEvaluation.checks },
  };

  const result = {
    // Canonical analysis object — single source of truth for the UI.
    ticker: q.ticker,
    companyName: q.companyName,
    analyzedAt: q.timestamp,
    timeframe: q.timeframe,
    marketSession: q.session,
    dataSources: { candles: "Yahoo Finance", quote: q.quote.source === "finnhub" ? "Finnhub" : "Yahoo Finance", news: "Finnhub", fundamentals: "Finnhub" },
    quote: q.quote,
    fundamentals: q.fundamentals,
    dataQuality: q.dataQuality,
    quantFeatures: q.features,
    indicators: {
      ema20: q.indicators.ema20, ema50: q.indicators.ema50, sma200: q.indicators.sma200, rsi14: q.indicators.rsi14,
      macd: q.indicators.macd, atr14: q.indicators.atr14, bollinger: q.indicators.bollinger, vwap: q.indicators.vwap,
      avgVolume20: q.indicators.avgVolume20, relativeVolume: q.indicators.relativeVolume, support: q.indicators.support,
      resistance: q.indicators.resistance, volatilityAnnualized: q.indicators.volatilityAnnualized, regime: q.indicators.regime,
      trend: q.indicators.trend, marketStructure: q.indicators.marketStructure,
    },
    technicalAnalysis: ta,
    marketStructure: q.structure,
    marketRegime: q.regime,
    historicalAnalogs: q.analogs,
    statistics: q.statistics,
    signalEngine: { long: signal.long, short: signal.short, chosenSide: engine.evaluatedSide, chosenScore: sideScore.score, minScoreForTrade: MIN_SIGNAL_SCORE },
    riskEngine: plans,
    tradeSetup,
    setup,
    analyst: {
      evaluation: analyst.evaluation,
      agreements: clean(analyst.agreements),
      conflictingSignals: clean(analyst.conflictingSignals),
      candidates: analyst.candidates,
      aiProposedSignal: d.signal,
      numericClaimCheck: claimCheck,
      guardrailNotes: d.signal !== finalSignal ? [`AI text proposed ${d.signal.replace("_", " ")}; the rule-based decision ${finalSignal.replace("_", " ")} is final.`] : [],
      rules: { minRiskReward: MIN_RISK_REWARD, minAlignedFactors: MIN_ALIGNED_FACTORS, minSignalScore: MIN_SIGNAL_SCORE },
    },
    model: CURRENT_MODEL,
    disclaimer:
      "Research and analysis only — not financial advice. Historical performance does not guarantee future results. Statistical probabilities are estimates, market conditions can change, and the system can be wrong.",
    riskReward: tp(0)?.rr ?? null,
    positionSize: tradeSetup.positionSizing.status === "ok" && tl
      ? { shares: tradeSetup.positionSizing.shares!, riskAmount: tradeSetup.positionSizing.maxRisk!, positionValue: tradeSetup.positionSizing.positionValue!, portfolioRiskPct: account!.riskPercent }
      : null,
    riskSettingsUsed: { accountSize, riskPercent, configured: !!account },
    news: q.news,
    newsIntelligence: news,
    insiderActivity: row.stage_data!.insider ?? { status: "unavailable" as const },
    nextEarningsDate: q.nextEarnings?.date ?? null,
    unavailableData: [
      ...q.errors,
      "economic calendar (not available on current data plan)",
      ...(news.status === "classification_unavailable" ? ["news classification (AI news analysis failed; headlines not assessed)"] : []),
    ],
    patternAnalysis: { selected: q.mtf.selectedReport, multiTimeframe: q.mtf.timeframes, alignment: q.mtf.alignment },
    // Developer/debug lineage (shown only in debug mode).
    debug: {
      pipeline: [
        { stage: "Market data", source: "Yahoo Finance chart API (candles), Finnhub (quote, news, earnings, profile, fundamentals, insider)", ai: false, deterministic: true },
        { stage: "Data quality / features / structure / regime / MTF / patterns / analogs / expectancy", source: "Deterministic engines on completed candles", ai: false, deterministic: true },
        { stage: "News classification", source: "Finnhub articles classified by AI; weighting + event risk in code", ai: true, deterministic: false },
        { stage: "Signal score / risk plan / tradeability", source: "Deterministic engines", ai: false, deterministic: true },
        { stage: "Analyst narrative", source: "AI interpretation of the package below; numbers verified", ai: true, deterministic: false },
      ],
      providerErrors: q.errors,
      riskInputs: { price, atr, supports, resistances, accountSize, riskPercent, analogMaeH5: exp5.avgMaePct, analogMfeH5: exp5.avgMfePct },
      tradeConstruction: { input: tradeInput, trace: tradeSetup.trace, levels: tl, filters: tradeSetup.filters, gateFailures, status: tradeSetup.status, statusReason: tradeSetup.statusReason, invalidation: tradeSetup.invalidation },
      aiInput: aiPayload,
      aiOutputRaw: rawAnalyst,
      numericClaimCheck: claimCheck,
    },
  };

  const { error } = await supabaseAdmin
    .from("analyses")
    .update({ status: "complete", signal: setup.signal, confidence: setup.confidence, result: j(result), stage_data: null })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new PipelineError(error.message);

  // Store every signal for future backtesting / model training.
  await supabaseAdmin.from("signals").insert({
    user_id: userId,
    analysis_id: id,
    ticker: q.ticker,
    timeframe: q.timeframe,
    signal: setup.signal,
    confidence: setup.confidence,
    long_score: signal.long.score,
    short_score: signal.short.score,
    price,
    entry: isTrade ? tl?.preferredEntry ?? null : null,
    stop_loss: isTrade ? tl?.stopLoss ?? null : null,
    take_profit_1: isTrade ? tp(0)?.price ?? null : null,
    take_profit_2: isTrade ? tp(1)?.price ?? null : null,
    take_profit_3: isTrade ? tp(2)?.price ?? null : null,
    risk_reward: isTrade ? tp(0)?.rr ?? null : null,
    market_regime: q.regime.label,
    historical_sample_size: exp5.sampleSize,
    feature_values: j({ features: q.features, alignmentScore: q.mtf.alignment.alignmentScore, structure: q.structure?.structure, eventRisk: news.eventRisk.level }),
    data_quality: q.dataQuality.status,
  });

  await supabaseAdmin.from("trade_setups").insert({
    user_id: userId,
    analysis_id: id,
    ticker: q.ticker,
    timeframe: q.timeframe,
    analysis_version: `${TRADE_SETUP_VERSION}/${CURRENT_MODEL.id}`,
    bias,
    side: tradeSetup.side,
    status: tradeSetup.status,
    status_reason: tradeSetup.statusReason,
    price,
    entry_zone_low: tl?.entryZoneLow ?? null,
    entry_zone_high: tl?.entryZoneHigh ?? null,
    preferred_entry: tl?.preferredEntry ?? null,
    stop_loss: tl?.stopLoss ?? null,
    take_profit_1: tp(0)?.price ?? null,
    take_profit_2: tp(1)?.price ?? null,
    take_profit_3: tp(2)?.price ?? null,
    rr_tp1: tp(0)?.rr ?? null,
    rr_tp2: tp(1)?.rr ?? null,
    rr_tp3: tp(2)?.rr ?? null,
    invalidation: tradeSetup.invalidation ? `${tradeSetup.invalidation.condition}. ${tradeSetup.invalidation.reason}` : null,
    position_shares: tradeSetup.positionSizing.shares,
    risk_percent: account?.riskPercent ?? null,
    account_size: account?.accountSize ?? null,
    supporting_features: j({ levels: tl, filters: tradeSetup.filters, alignmentScore: q.mtf.alignment.alignmentScore, regime: q.regime.label, eventRisk: news.eventRisk.level, signalScore: { long: signal.long.score, short: signal.short.score } }),
  });

  // Alert (deduped per analysis) when a watchlist setup is READY. Deterministic; no AI involved.
  if (tradeSetup.status === "READY" && tradeSetup.side && tl) {
    try {
      const { sendAlert, onWatchlist } = await import("./alerts.server");
      if (await onWatchlist(userId, q.ticker, q.timeframe)) {
        await sendAlert({ userId, analysisId: id, ticker: q.ticker, kind: "READY", price,
          message: `${q.ticker} ${tradeSetup.side} setup is READY (${q.timeframe}) — entry ${tl.entryZoneLow}–${tl.entryZoneHigh}, stop ${tl.stopLoss}, TP1 ${tp(0)?.price ?? "n/a"}` });
      }
    } catch (e) { console.error("ready alert failed", e); }
  }

  return { id, result };
}
