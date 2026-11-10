// Pure pre-trade risk gate. Decides whether a READY setup may become a broker order and re-sizes it against the
// broker's real equity (paper accounts default to $100k, which would silently 10x a $10k risk setting).
import { INTRADAY_TFS, TF_MINUTES } from "./time";
import type { ExecutionSettings, SetupRow } from "./types";

export interface GateFailure {
  code: string;
  message: string;
}
export interface ActiveRisk {
  ticker: string;
  qty: number;
  entry: number;
  stop: number;
}
export interface GateContext {
  now: Date;
  equity: number;
  buyingPower: number;
  dayPnl: number; // broker-reported equity minus last close equity (includes unrealized)
  tradingBlocked: boolean;
  marketOpen: boolean;
  minutesSinceOpen: number | null;
  minutesToClose: number | null;
  quote: number | null;
  quoteAgeSec: number | null;
  active: ActiveRisk[]; // our non-terminal orders for this mode
  tradesToday: number; // orders that became (or are becoming) trades since midnight ET
  lossStreakToday: number; // consecutive losing closes today, most recent first
  lastLossAtForTicker: string | null;
}
export interface OrderPlan {
  qty: number;
  limitPrice: number;
  stopPrice: number;
  takePrice: number;
  riskAmount: number;
  rr: number;
  rewardBps: number;
  expiresInMin: number;
}
export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
  plan: OrderPlan | null;
}

export const MAX_QUOTE_AGE_SEC = 60;
export const LIVE_ARM_WINDOW_HOURS = 24;
/** Minimum minutes a trade must have left after the forced-flatten window starts, or it is not worth entering. */
export const MIN_RUNWAY_MIN = 15;
const cents = (n: number) => Math.round(n * 100) / 100;

export function evaluateGate(s: ExecutionSettings, setup: SetupRow, c: GateContext): GateResult {
  const f: GateFailure[] = [];
  const fail = (code: string, message: string) => {
    f.push({ code, message });
  };

  // --- account / switches
  if (s.mode === "off") fail("MODE_OFF", "Execution is off.");
  if (s.killSwitch) fail("KILL_SWITCH", "Kill switch is engaged.");
  if (s.mode === "live") {
    const armed = s.liveArmedAt
      ? (c.now.getTime() - new Date(s.liveArmedAt).getTime()) / 36e5
      : Infinity;
    if (!(armed >= 0 && armed <= LIVE_ARM_WINDOW_HOURS))
      fail("LIVE_NOT_ARMED", `Live trading must be re-armed every ${LIVE_ARM_WINDOW_HOURS}h.`);
  }
  if (c.tradingBlocked)
    fail("ACCOUNT_BLOCKED", "Broker reports trading is blocked on this account.");

  // --- session timing: no overnight risk, no opening-auction chaos, no entries with no time left
  if (!c.marketOpen) fail("MARKET_CLOSED", "Market is closed.");
  else if (c.minutesToClose == null || c.minutesSinceOpen == null)
    fail("CLOCK_UNKNOWN", "Could not determine session timing.");
  else {
    if (c.minutesSinceOpen < s.avoidOpenMin)
      fail("AVOID_OPEN", `Within the first ${s.avoidOpenMin} min after the open.`);
    if (c.minutesToClose <= s.flattenMinBeforeClose + MIN_RUNWAY_MIN)
      fail("NEAR_CLOSE", `Too close to the bell (${Math.round(c.minutesToClose)} min left).`);
  }

  // --- setup
  if (setup.status !== "READY")
    fail("NOT_READY", `Setup is ${setup.status}; only READY setups are executed.`);
  if (!INTRADAY_TFS.includes(setup.timeframe))
    fail(
      "NOT_INTRADAY",
      `Timeframe ${setup.timeframe} is not tradable here (use ${INTRADAY_TFS.join(", ")}).`,
    );
  if (!setup.side) fail("NO_SIDE", "Setup has no side.");
  if (setup.side === "SHORT" && !s.allowShort)
    fail("SHORT_DISABLED", "Shorting is disabled in execution settings.");
  const ageMin = (c.now.getTime() - new Date(setup.createdAt).getTime()) / 6e4;
  if (!(ageMin <= s.maxSetupAgeMin))
    fail("SETUP_STALE", `Setup is ${Math.round(ageMin)} min old (limit ${s.maxSetupAgeMin}).`);
  const { entryZoneLow: zl, entryZoneHigh: zh, stopLoss, takeProfit1, riskPercent } = setup;
  if (zl == null || zh == null || stopLoss == null || takeProfit1 == null)
    fail("LEVELS_MISSING", "Setup is missing entry zone, stop or target.");
  if (riskPercent == null)
    fail("NO_RISK_SETTINGS", "Save risk settings first; the order size depends on them.");

  // --- portfolio and day-level brakes
  if (c.active.some((a) => a.ticker === setup.ticker))
    fail("DUPLICATE_TICKER", `Already have an active ${setup.ticker} order.`);
  if (c.active.length >= s.maxOpenPositions)
    fail("MAX_POSITIONS", `Already at ${s.maxOpenPositions} active orders.`);
  if (c.dayPnl <= -(c.equity * s.maxDailyLossPct) / 100)
    fail(
      "DAILY_LOSS",
      `Day P&L ${cents(c.dayPnl)} breaches the ${s.maxDailyLossPct}% daily loss limit.`,
    );
  if (c.tradesToday >= s.maxTradesPerDay)
    fail("MAX_TRADES_DAY", `Already ${c.tradesToday} trades today (limit ${s.maxTradesPerDay}).`);
  if (c.lossStreakToday >= s.maxConsecutiveLosses)
    fail(
      "LOSS_STREAK",
      `${c.lossStreakToday} losses in a row today: no new entries until tomorrow.`,
    );
  if (
    c.lastLossAtForTicker &&
    (c.now.getTime() - new Date(c.lastLossAtForTicker).getTime()) / 6e4 < s.tickerCooldownMin
  )
    fail("COOLDOWN", `${setup.ticker} lost recently; cooling down for ${s.tickerCooldownMin} min.`);

  // --- price
  if (c.quote == null) fail("NO_QUOTE", "No current quote.");
  else if (c.quoteAgeSec == null || c.quoteAgeSec > MAX_QUOTE_AGE_SEC)
    fail("QUOTE_STALE", `Quote is older than ${MAX_QUOTE_AGE_SEC}s.`);

  if (
    f.length ||
    !setup.side ||
    c.quote == null ||
    zl == null ||
    zh == null ||
    stopLoss == null ||
    takeProfit1 == null ||
    riskPercent == null
  )
    return { ok: false, failures: f, plan: null };

  // --- plan: marketable limit capped at the zone edge, so we never chase beyond what the setup was built for
  const long = setup.side === "LONG";
  if (c.quote < zl || c.quote > zh)
    fail("PRICE_OUTSIDE_ZONE", `Quote ${c.quote} is outside the entry zone ${zl}-${zh}.`);
  const collar = s.entryCollarBps / 1e4;
  const limitPrice = cents(
    long ? Math.min(c.quote * (1 + collar), zh) : Math.max(c.quote * (1 - collar), zl),
  );
  const stopPrice = cents(stopLoss),
    takePrice = cents(takeProfit1);
  const ordered = long
    ? stopPrice < limitPrice && limitPrice < takePrice
    : takePrice < limitPrice && limitPrice < stopPrice;
  if (!ordered)
    fail(
      "LEVELS_INVALID",
      "Stop / entry / target are not in a valid order for this side (price may already be through a level).",
    );
  const stopDist = Math.abs(limitPrice - stopPrice);
  const rr = stopDist > 0 ? Math.abs(takePrice - limitPrice) / stopDist : 0;
  if (rr < s.minRr)
    fail("RR_TOO_LOW", `R:R at the order price is ${rr.toFixed(2)} (minimum ${s.minRr}).`);
  // Costs are the main thing that kills short-timeframe strategies: skip trades whose target is too small relative to them.
  const rewardBps = (Math.abs(takePrice - limitPrice) / limitPrice) * 1e4;
  if (rewardBps < s.estCostBps * s.minCostMultiple)
    fail(
      "COST_TOO_HIGH",
      `Target is ${rewardBps.toFixed(0)} bps away; needs at least ${s.minCostMultiple}x the ${s.estCostBps} bps round-trip cost.`,
    );
  if (f.length) return { ok: false, failures: f, plan: null };

  const base = Math.min(setup.accountSize ?? c.equity, c.equity);
  const riskAmount = (base * riskPercent) / 100;
  const qty = Math.min(
    Math.floor(riskAmount / stopDist),
    setup.positionShares ?? Infinity,
    Math.floor((c.equity * s.maxPositionPct) / 100 / limitPrice),
    Math.floor(c.buyingPower / limitPrice),
  );
  if (!(qty >= 1)) {
    fail(
      "QTY_ZERO",
      "Position size rounds to zero shares under the risk, size and buying-power limits.",
    );
    return { ok: false, failures: f, plan: null };
  }

  const openRisk = c.active.reduce((sum, a) => sum + Math.abs(a.entry - a.stop) * a.qty, 0);
  const cap = (c.equity * s.maxOpenRiskPct) / 100;
  if (openRisk + qty * stopDist > cap)
    fail("OPEN_RISK", `Total open risk would exceed ${s.maxOpenRiskPct}% of equity.`);
  if (f.length) return { ok: false, failures: f, plan: null };

  return {
    ok: true,
    failures: [],
    plan: {
      qty,
      limitPrice,
      stopPrice,
      takePrice,
      riskAmount: cents(qty * stopDist),
      rr: Math.round(rr * 100) / 100,
      rewardBps: Math.round(rewardBps),
      expiresInMin: (TF_MINUTES[setup.timeframe] ?? 15) * s.entryExpiryBars,
    },
  };
}
