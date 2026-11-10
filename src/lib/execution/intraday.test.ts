import { describe, expect, it } from "vitest";
import { createAutopilot, type AnalyzeResult } from "./autopilot";
import { BrokerError, type BrokerOrder } from "./broker";
import { createEngine } from "./engine";
import { deterministicEventRisk } from "./event-risk";
import { evaluateGate } from "./gate";
import { deriveEvents } from "./reconcile";
import { sessionOpenEt, startOfEtDay } from "./time";
import { FakeBroker, MemoryStore } from "./testing";
import { DEFAULT_SETTINGS, type ExecutionSettings, type OrderStatus } from "./types";

const NOW = new Date("2026-03-04T15:00:00Z"); // 10:00 ET, 30 min after the open, 360 min before the close
const min = (n: number) => new Date(NOW.getTime() + n * 60_000);
const settings = (o: Partial<ExecutionSettings> = {}): ExecutionSettings => ({
  userId: "u1",
  ...DEFAULT_SETTINGS,
  mode: "paper",
  ...o,
});
const setup = (o = {}) => ({
  id: "s1",
  userId: "u1",
  ticker: "AAPL",
  side: "LONG" as const,
  status: "READY",
  timeframe: "15m",
  createdAt: NOW.toISOString(),
  entryZoneLow: 99,
  entryZoneHigh: 101,
  preferredEntry: 100,
  stopLoss: 96,
  takeProfit1: 108,
  positionShares: 50,
  riskPercent: 1,
  accountSize: 10_000,
  ...o,
});
const ctx = (o = {}) => ({
  now: NOW,
  equity: 100_000,
  buyingPower: 400_000,
  dayPnl: 0,
  tradingBlocked: false,
  marketOpen: true,
  minutesSinceOpen: 30,
  minutesToClose: 360,
  quote: 100,
  quoteAgeSec: 2,
  active: [],
  tradesToday: 0,
  lossStreakToday: 0,
  lastLossAtForTicker: null as string | null,
  ...o,
});
const codes = (o: { failures: { code: string }[] }) => o.failures.map((f) => f.code);

describe("ET session time (DST-safe)", () => {
  it("winter: open 14:30Z, midnight 05:00Z", () => {
    expect(sessionOpenEt(NOW).toISOString()).toBe("2026-03-04T14:30:00.000Z");
    expect(startOfEtDay(NOW).toISOString()).toBe("2026-03-04T05:00:00.000Z");
  });
  it("summer: open 13:30Z, midnight 04:00Z", () => {
    const d = new Date("2026-07-01T15:00:00Z");
    expect(sessionOpenEt(d).toISOString()).toBe("2026-07-01T13:30:00.000Z");
    expect(startOfEtDay(d).toISOString()).toBe("2026-07-01T04:00:00.000Z");
  });
  it("handles the DST switch days", () => {
    const spring = new Date("2026-03-08T16:00:00Z"); // clocks went forward at 02:00 that morning
    expect(sessionOpenEt(spring).toISOString()).toBe("2026-03-08T13:30:00.000Z");
    expect(startOfEtDay(spring).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    const fall = new Date("2026-11-01T16:00:00Z"); // clocks went back
    expect(sessionOpenEt(fall).toISOString()).toBe("2026-11-01T14:30:00.000Z");
    expect(startOfEtDay(fall).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
  it("a UTC time just after midnight UTC is still the previous ET day", () => {
    expect(startOfEtDay(new Date("2026-03-04T04:59:00Z")).toISOString()).toBe(
      "2026-03-03T05:00:00.000Z",
    );
  });
});

describe("earnings event risk (no AI)", () => {
  const at = new Date("2026-03-04T15:00:00Z");
  it.each([
    ["2026-03-04", "high"],
    ["2026-03-05", "high"],
    ["2026-03-03", "high"],
    ["2026-03-07", "elevated"],
    ["2026-03-20", "normal"],
    ["2026-02-20", "normal"],
  ] as const)("earnings %s -> %s", (date, level) => {
    expect(deterministicEventRisk(date, at).eventRisk.level).toBe(level);
  });
  it("unknown date is normal but flagged; news is always marked unassessed", () => {
    const r = deterministicEventRisk(null, at);
    expect(r.eventRisk.level).toBe("normal");
    expect(r.eventRisk.factors.join(" ")).toMatch(/unknown/);
    expect(r.eventRisk.factors.join(" ")).toMatch(/news not assessed/);
    expect(r.netSentiment.label).toBe("unavailable");
  });
});

describe("intraday gate", () => {
  it("approves and gives an entry expiry of bars x timeframe", () => {
    const r = evaluateGate(settings(), setup(), ctx());
    expect(r.ok).toBe(true);
    expect(r.plan!.expiresInMin).toBe(30); // 2 bars x 15m
    expect(r.plan!.rewardBps).toBeGreaterThan(32);
  });
  it("5m timeframe expires faster", () => {
    expect(evaluateGate(settings(), setup({ timeframe: "5m" }), ctx()).plan!.expiresInMin).toBe(10);
  });
  it.each([
    ["first minutes after open", ctx({ minutesSinceOpen: 5 }), "AVOID_OPEN"],
    ["too close to the bell", ctx({ minutesToClose: 25 }), "NEAR_CLOSE"],
    ["unknown clock", ctx({ minutesToClose: null }), "CLOCK_UNKNOWN"],
    ["max trades reached", ctx({ tradesToday: 10 }), "MAX_TRADES_DAY"],
    ["loss streak", ctx({ lossStreakToday: 3 }), "LOSS_STREAK"],
    ["ticker cooldown", ctx({ lastLossAtForTicker: min(-10).toISOString() }), "COOLDOWN"],
  ] as const)("blocks: %s", (_n, c, code) => {
    expect(codes(evaluateGate(settings(), setup(), c))).toContain(code);
  });
  it("cooldown ends", () => {
    expect(
      evaluateGate(settings(), setup(), ctx({ lastLossAtForTicker: min(-31).toISOString() })).ok,
    ).toBe(true);
  });
  it("blocks non-intraday timeframes", () => {
    expect(codes(evaluateGate(settings(), setup({ timeframe: "1d" }), ctx()))).toContain(
      "NOT_INTRADAY",
    );
  });
  it("blocks targets that are too small relative to costs", () => {
    // target 100.3 vs entry 100.1 = ~20 bps < 8 bps x 4 = 32
    const r = evaluateGate(
      settings({ minRr: 1 }),
      setup({ takeProfit1: 100.4, stopLoss: 99.8 }),
      ctx(),
    );
    expect(codes(r)).toContain("COST_TOO_HIGH");
  });
});

describe("intraday reconcile rules", () => {
  const base = {
    now: NOW,
    marketOpen: true,
    minutesToClose: 360,
    maxHoldMin: 180,
    flattenMinBeforeClose: 15,
    flattenUnprotected: true,
  };
  const bo = (o: Partial<BrokerOrder> = {}): BrokerOrder => ({
    id: "b1",
    clientOrderId: "c",
    symbol: "AAPL",
    status: "working" as const,
    qty: 10,
    filledQty: 0,
    avgFillPrice: null,
    legs: [
      {
        id: "t",
        kind: "take" as const,
        status: "working" as const,
        filledQty: 0,
        avgFillPrice: null,
      },
      {
        id: "s",
        kind: "stop" as const,
        status: "working" as const,
        filledQty: 0,
        avgFillPrice: null,
      },
    ],
    ...o,
  });
  const filled = bo({ status: "filled", filledQty: 10, avgFillPrice: 100 });
  const pos = { symbol: "AAPL", qty: 10, avgEntryPrice: 100 };
  const ord = (o = {}) => ({
    status: "SUBMITTED" as OrderStatus,
    filledQty: 0,
    openedAt: null,
    createdAt: NOW.toISOString(),
    expiresAt: null,
    ...o,
  });

  it("cancels an unfilled entry after its window", () => {
    const r = deriveEvents({
      ...base,
      order: ord({ expiresAt: min(-1).toISOString() }),
      brokerOrder: bo(),
      position: null,
    });
    expect(r.actions).toEqual([{ type: "CANCEL_ENTRY", reason: expect.any(String) }]);
    expect(
      deriveEvents({
        ...base,
        order: ord({ expiresAt: min(10).toISOString() }),
        brokerOrder: bo(),
        position: null,
      }).actions,
    ).toEqual([]);
  });
  it("cancels a resting entry when the close approaches", () => {
    const r = deriveEvents({
      ...base,
      minutesToClose: 10,
      order: ord({ expiresAt: min(60).toISOString() }),
      brokerOrder: bo(),
      position: null,
    });
    expect(r.actions[0]).toMatchObject({ type: "CANCEL_ENTRY" });
  });
  it("flattens open positions before the close", () => {
    const r = deriveEvents({
      ...base,
      minutesToClose: 12,
      order: ord({ status: "OPEN", filledQty: 10, openedAt: min(-20).toISOString() }),
      brokerOrder: filled,
      position: pos,
    });
    expect(r.actions).toEqual([{ type: "FLATTEN", reason: "EOD" }]);
  });
  it("an unprotected position is flattened as UNPROTECTED even at EOD", () => {
    const b = bo({ status: "filled", filledQty: 10, avgFillPrice: 100 });
    b.legs[1]!.status = "canceled";
    const r = deriveEvents({
      ...base,
      minutesToClose: 12,
      order: ord({ status: "OPEN", filledQty: 10, openedAt: min(-20).toISOString() }),
      brokerOrder: b,
      position: pos,
    });
    expect(r.actions).toEqual([{ type: "FLATTEN", reason: "UNPROTECTED" }]);
  });
  it("after the bell it alerts instead of sending a close that would queue for tomorrow", () => {
    const r = deriveEvents({
      ...base,
      marketOpen: false,
      minutesToClose: null,
      order: ord({ status: "OPEN", filledQty: 10, openedAt: min(-300).toISOString() }),
      brokerOrder: filled,
      position: pos,
    });
    expect(r.actions).toEqual([]);
    expect(r.anomalies).toContain("POSITION_HELD_OUTSIDE_SESSION");
  });
});

function rig(over: Partial<ExecutionSettings> = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const broker = new FakeBroker("paper");
  const store = new MemoryStore(now);
  store.addUser("u1", over);
  const engine = createEngine({ broker, store, now });
  return { clock, broker, store, engine };
}

describe("intraday engine behaviour", () => {
  it("cancels an entry that never fills, then marks it CANCELED", async () => {
    const { clock, broker, store, engine } = rig();
    const s = store.addSetup();
    await engine.place("u1", s.id);
    clock.t = min(31); // past 2 bars x 15m
    const r1 = await engine.reconcile("u1");
    expect(r1.canceled).toBe(1);
    expect(broker.cancelled).toHaveLength(1);
    await engine.reconcile("u1");
    expect(store.orders[0]!.status).toBe("CANCELED");
  });
  it("flattens at end of day and records the reason", async () => {
    const { clock, broker, store, engine } = rig();
    const s = store.addSetup();
    await engine.place("u1", s.id);
    broker.fill(`tm-paper-${s.id}`, 100);
    await engine.reconcile("u1");
    clock.t = new Date("2026-03-04T20:50:00Z"); // 10 min before the 21:00Z close
    const r = await engine.reconcile("u1");
    expect(r.flattened).toBe(1);
    expect(broker.closed).toEqual(["AAPL"]);
    await engine.reconcile("u1");
    expect(store.orders[0]).toMatchObject({ status: "CLOSED", exitReason: "EOD" });
  });
  it("does not hammer the broker or spam alerts when a flatten keeps failing", async () => {
    const { clock, broker, store, engine } = rig();
    const s = store.addSetup();
    await engine.place("u1", s.id);
    broker.fill(`tm-paper-${s.id}`, 100);
    await engine.reconcile("u1");
    let attempts = 0;
    broker.closePosition = async () => {
      attempts++;
      throw new BrokerError("rejected", "insufficient qty available", 403);
    };
    clock.t = new Date("2026-03-04T20:50:00Z");
    await engine.reconcile("u1");
    clock.t = new Date("2026-03-04T20:51:00Z");
    await engine.reconcile("u1"); // inside the 2-minute window: no retry
    expect(attempts).toBe(1);
    clock.t = new Date("2026-03-04T20:53:00Z");
    await engine.reconcile("u1"); // retries, but does not alert again
    expect(attempts).toBe(2);
    expect(store.notes.filter((n) => n.includes("FAILED to flatten"))).toHaveLength(1);
  });
  async function stopOut(r: ReturnType<typeof rig>, ticker: string) {
    const s = r.store.addSetup({ ticker, createdAt: r.clock.t.toISOString() });
    const res = await r.engine.place("u1", s.id);
    expect(res.ok).toBe(true);
    const cid = `tm-paper-${s.id}`;
    r.broker.fill(cid, 100.1);
    await r.engine.reconcile("u1");
    r.broker.hitLeg(cid, "stop", 96);
    await r.engine.reconcile("u1");
    expect(r.store.orders.find((o) => o.clientOrderId === cid)!.realizedPnl).toBeLessThan(0);
  }
  it("halts new entries after N consecutive losses, and resets the next day", async () => {
    const r = rig({ maxConsecutiveLosses: 3, tickerCooldownMin: 0 });
    for (const t of ["AAPL", "MSFT", "NVDA"]) await stopOut(r, t);
    const blocked = await r.engine.place("u1", r.store.addSetup({ ticker: "AMD" }).id);
    expect(blocked).toMatchObject({ ok: false, code: "GATE_BLOCKED" });
    expect((blocked as { failures: { code: string }[] }).failures.map((f) => f.code)).toContain(
      "LOSS_STREAK",
    );
    r.clock.t = new Date("2026-03-05T15:00:00Z");
    r.broker.nextClose = new Date("2026-03-05T21:00:00Z");
    const next = await r.engine.place(
      "u1",
      r.store.addSetup({ ticker: "AMD", createdAt: r.clock.t.toISOString() }).id,
    );
    expect(next.ok).toBe(true);
  });
  it("cools a ticker down after a loss, then allows it again", async () => {
    const r = rig({ tickerCooldownMin: 30 });
    await stopOut(r, "AAPL");
    r.clock.t = min(10);
    const early = await r.engine.place(
      "u1",
      r.store.addSetup({ ticker: "AAPL", createdAt: r.clock.t.toISOString() }).id,
    );
    expect((early as { failures: { code: string }[] }).failures.map((f) => f.code)).toContain(
      "COOLDOWN",
    );
    r.clock.t = min(40);
    expect(
      (
        await r.engine.place(
          "u1",
          r.store.addSetup({ ticker: "AAPL", createdAt: r.clock.t.toISOString() }).id,
        )
      ).ok,
    ).toBe(true);
  });
  it("caps trades per day", async () => {
    const r = rig({ maxTradesPerDay: 2 });
    expect((await r.engine.place("u1", r.store.addSetup({ ticker: "AAPL" }).id)).ok).toBe(true);
    expect((await r.engine.place("u1", r.store.addSetup({ ticker: "MSFT" }).id)).ok).toBe(true);
    const third = await r.engine.place("u1", r.store.addSetup({ ticker: "NVDA" }).id);
    expect((third as { failures: { code: string }[] }).failures.map((f) => f.code)).toContain(
      "MAX_TRADES_DAY",
    );
  });
});

describe("autopilot", () => {
  const T0 = new Date("2026-03-04T15:00:30Z"); // 30s after the 15:00 bar boundary
  function ap(
    over: Partial<ExecutionSettings> = {},
    watch = ["AAPL", "MSFT", "NVDA", "AMD", "TSLA", "META"],
    withSetups = new Set(watch),
  ) {
    const clock = { t: T0 };
    const now = () => clock.t;
    const broker = new FakeBroker("paper");
    const store = new MemoryStore(now);
    store.addUser("u1", { autopilotEnabled: true, ...over });
    store.watch.set("u1", watch);
    const engine = createEngine({ broker, store, now });
    const analysed: string[] = [];
    const analyze = async (_u: string, ticker: string): Promise<AnalyzeResult> => {
      analysed.push(ticker);
      if (ticker === "BOOM") throw new Error("provider down");
      return withSetups.has(ticker)
        ? { kind: "setup", setupId: store.addSetup({ ticker, createdAt: now().toISOString() }).id }
        : { kind: "none", reason: "NO_TRADE: no structure" };
    };
    return {
      clock,
      broker,
      store,
      engine,
      analysed,
      pilot: createAutopilot({ engine, store, broker, analyze, now, batchSize: 4 }),
    };
  }
  it("does nothing unless enabled, executing, and the market is open", async () => {
    expect(await ap({ autopilotEnabled: false }).pilot.tick("u1")).toEqual({
      ran: false,
      reason: "autopilot_off",
    });
    expect(await ap({ killSwitch: true }).pilot.tick("u1")).toEqual({
      ran: false,
      reason: "execution_off",
    });
    expect(await ap({ mode: "off" }).pilot.tick("u1")).toEqual({
      ran: false,
      reason: "execution_off",
    });
    const closed = ap();
    closed.broker.isOpen = false;
    expect(await closed.pilot.tick("u1")).toEqual({ ran: false, reason: "market_closed" });
  });
  it("waits for the bar to settle", async () => {
    const r = ap();
    r.clock.t = new Date("2026-03-04T15:00:05Z");
    expect(await r.pilot.tick("u1")).toEqual({ ran: false, reason: "settling" });
  });
  it("scans the watchlist in batches, once per bar, and places orders for READY setups", async () => {
    const r = ap({ maxTradesPerDay: 50, maxOpenPositions: 10 });
    const t1 = await r.pilot.tick("u1");
    expect(t1).toMatchObject({ ran: true, analysed: 4, placed: 4, done: false });
    const t2 = await r.pilot.tick("u1");
    expect(t2).toMatchObject({ ran: true, analysed: 2, placed: 2, done: true });
    expect(await r.pilot.tick("u1")).toEqual({ ran: false, reason: "bar_already_scanned" });
    expect(r.analysed).toHaveLength(6);
    expect(r.broker.orders.size).toBe(6);
    r.clock.t = new Date("2026-03-04T15:15:30Z"); // next bar
    expect((await r.pilot.tick("u1")).ran).toBe(true);
  });
  it("skips tickers it is already in, without spending an analysis on them", async () => {
    const r = ap({}, ["AAPL", "MSFT"]);
    await r.engine.place(
      "u1",
      r.store.addSetup({ ticker: "AAPL", createdAt: T0.toISOString() }).id,
    );
    await r.pilot.tick("u1");
    expect(r.analysed).toEqual(["MSFT"]);
    expect(r.store.runs[0]!.skipped["AAPL"]).toBe("already in a position");
  });
  it("records NO_TRADE reasons and keeps going after a provider error", async () => {
    const r = ap({}, ["BOOM", "AAPL", "MSFT"], new Set(["AAPL"]));
    const t = await r.pilot.tick("u1");
    expect(t).toMatchObject({ ran: true, analysed: 3, placed: 1, done: true });
    expect(r.store.runs[0]!.errors[0]).toMatch(/BOOM: provider down/);
    expect(r.store.runs[0]!.skipped["MSFT"]).toMatch(/NO_TRADE/);
  });
  it("stops scanning the moment a day-level brake trips instead of burning data calls", async () => {
    const r = ap({ maxTradesPerDay: 1 }, ["AAPL", "MSFT", "NVDA", "AMD"]);
    const t = await r.pilot.tick("u1");
    expect(t).toMatchObject({ analysed: 2, placed: 1, done: true });
    expect(r.analysed).toEqual(["AAPL", "MSFT"]);
    expect(r.store.runs[0]!.skipped["MSFT"]).toContain("MAX_TRADES_DAY");
  });
});
