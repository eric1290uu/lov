import { describe, expect, it } from "vitest";
import { AlpacaBroker, mapOrder, mapStatus } from "./alpaca.server";
import { BrokerError, type BrokerOrder } from "./broker";
import { createEngine } from "./engine";
import { evaluateGate } from "./gate";
import { deriveEvents } from "./reconcile";
import { applyEvent, canTransition } from "./state";
import { FakeBroker, MemoryStore } from "./testing";
import { DEFAULT_SETTINGS, type ExecutionSettings, type OrderStatus } from "./types";

const NOW = new Date("2026-03-04T15:00:00Z");
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
  lastLossAtForTicker: null,
  ...o,
});
const codes = (r: ReturnType<typeof evaluateGate>) => r.failures.map((f) => f.code);

describe("state machine", () => {
  it("allows the happy path and rejects illegal jumps", () => {
    expect(canTransition("PENDING", "SENT")).toBe(true);
    expect(canTransition("CLOSED", "ENTRY_FILLED")).toBe(false);
    expect(canTransition("CANCELED", "EXIT_FILLED")).toBe(false);
    const r = applyEvent(
      { status: "CLOSED", side: "LONG", filledQty: 1, entryPrice: 1, exitHint: null },
      { type: "PROTECTION_LOST", detail: "x" },
      NOW.toISOString(),
    );
    expect(r.ok).toBe(false);
  });
  it("computes gross P&L for longs and shorts and keeps the flatten reason", () => {
    const l = applyEvent(
      { status: "OPEN", side: "LONG", filledQty: 10, entryPrice: 100, exitHint: "TIME" },
      { type: "EXIT_FILLED", reason: "MANUAL", exitPrice: 104 },
      "t",
    );
    expect(l.ok && l.patch).toMatchObject({
      status: "CLOSED",
      realizedPnl: 40,
      exitReason: "TIME",
    });
    const s = applyEvent(
      { status: "OPEN", side: "SHORT", filledQty: 10, entryPrice: 100, exitHint: null },
      { type: "EXIT_FILLED", reason: "STOP", exitPrice: 104 },
      "t",
    );
    expect(s.ok && s.patch.realizedPnl).toBe(-40);
  });
  it("a cancelled remainder of a partial fill leaves a live position, not a cancelled order", () => {
    const r = applyEvent(
      { status: "PARTIALLY_FILLED", side: "LONG", filledQty: 5, entryPrice: 100, exitHint: null },
      { type: "ENTRY_CANCELED", reason: "r" },
      "t",
    );
    expect(r.ok && r.patch.status).toBe("OPEN");
  });
  it("ignores stale partial fills", () => {
    expect(
      applyEvent(
        { status: "PARTIALLY_FILLED", side: "LONG", filledQty: 5, entryPrice: 100, exitHint: null },
        { type: "PARTIAL_FILL", filledQty: 5, avgPrice: 100 },
        "t",
      ).ok,
    ).toBe(false);
  });
});

describe("risk gate", () => {
  it("approves a clean READY setup and sizes by risk, capped by position size", () => {
    const r = evaluateGate(settings(), setup(), ctx());
    expect(r.ok).toBe(true);
    // limit = min(100*1.001, 101) = 100.1; stop dist 4.1; risk 1% of min(10k,100k)=100 -> 24 sh
    expect(r.plan).toMatchObject({ qty: 24, limitPrice: 100.1, stopPrice: 96, takePrice: 108 });
  });
  it("sizes off the smaller of saved account size and broker equity", () => {
    expect(
      evaluateGate(
        settings(),
        setup({ accountSize: 1_000_000, positionShares: 9999 }),
        ctx({ equity: 10_000, buyingPower: 40_000 }),
      ).plan!.qty,
    ).toBeLessThanOrEqual(20); // 1% of 10k / 4.1 = 24, but 20% position cap = 19
  });
  it.each([
    ["mode off", settings({ mode: "off" }), setup(), ctx(), "MODE_OFF"],
    ["kill switch", settings({ killSwitch: true }), setup(), ctx(), "KILL_SWITCH"],
    ["waiting setup", settings(), setup({ status: "WAITING_FOR_ENTRY" }), ctx(), "NOT_READY"],
    ["short disabled", settings(), setup({ side: "SHORT" }), ctx(), "SHORT_DISABLED"],
    ["stale setup", settings(), setup({ createdAt: "2026-03-04T10:00:00Z" }), ctx(), "SETUP_STALE"],
    ["market closed", settings(), setup(), ctx({ marketOpen: false }), "MARKET_CLOSED"],
    ["stale quote", settings(), setup(), ctx({ quoteAgeSec: 600 }), "QUOTE_STALE"],
    [
      "duplicate ticker",
      settings(),
      setup(),
      ctx({ active: [{ ticker: "AAPL", qty: 1, entry: 100, stop: 96 }] }),
      "DUPLICATE_TICKER",
    ],
    ["daily loss", settings(), setup(), ctx({ dayPnl: -2500 }), "DAILY_LOSS"],
    ["outside zone", settings(), setup(), ctx({ quote: 103 }), "PRICE_OUTSIDE_ZONE"],
    ["blocked account", settings(), setup(), ctx({ tradingBlocked: true }), "ACCOUNT_BLOCKED"],
    ["live not armed", settings({ mode: "live" }), setup(), ctx(), "LIVE_NOT_ARMED"],
    [
      "live arm expired",
      settings({ mode: "live", liveArmedAt: "2026-03-02T00:00:00Z" }),
      setup(),
      ctx(),
      "LIVE_NOT_ARMED",
    ],
  ] as const)("blocks: %s", (_n, s, st, c, code) => {
    expect(codes(evaluateGate(s, st, c))).toContain(code);
  });
  it("blocks when R:R at the order price is too low", () => {
    expect(
      codes(evaluateGate(settings({ minRr: 3 }), setup({ takeProfit1: 104 }), ctx())),
    ).toContain("RR_TOO_LOW");
  });
  it("blocks when total open risk would exceed the cap", () => {
    const heavy = [{ ticker: "MSFT", qty: 1000, entry: 100, stop: 94 }]; // 6000 existing risk already at the 6% cap, any new risk exceeds it
    expect(codes(evaluateGate(settings(), setup(), ctx({ active: heavy })))).toContain("OPEN_RISK");
  });
  it("allows live when armed within 24h", () => {
    expect(
      evaluateGate(settings({ mode: "live", liveArmedAt: "2026-03-04T09:00:00Z" }), setup(), ctx())
        .ok,
    ).toBe(true);
  });
});

describe("reconcile derivation", () => {
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
    status: "filled" as const,
    qty: 10,
    filledQty: 10,
    avgFillPrice: 100,
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
  const pos = { symbol: "AAPL", qty: 10, avgEntryPrice: 100 };
  const ord = (o = {}) => ({
    status: "SUBMITTED" as OrderStatus,
    filledQty: 0,
    openedAt: null,
    createdAt: NOW.toISOString(),
    expiresAt: null,
    ...o,
  });

  it("fill with live stop -> OPEN, no actions", () => {
    const r = deriveEvents({ ...base, order: ord(), brokerOrder: bo(), position: pos });
    expect(r.events.map((e) => e.type)).toEqual(["ENTRY_FILLED"]);
    expect(r.actions).toEqual([]);
  });
  it("detects a missing stop and flattens (the original -5.3% failure)", () => {
    const b = bo();
    b.legs[1]!.status = "canceled";
    const r = deriveEvents({
      ...base,
      order: ord({ status: "OPEN", filledQty: 10, openedAt: NOW.toISOString() }),
      brokerOrder: b,
      position: pos,
    });
    expect(r.events.map((e) => e.type)).toEqual(["PROTECTION_LOST"]);
    expect(r.actions).toEqual([{ type: "FLATTEN", reason: "UNPROTECTED" }]);
  });
  it("entry fill and stop-out between two polls produce both events in order", () => {
    const b = bo();
    b.legs[1]!.status = "filled";
    b.legs[1]!.avgFillPrice = 96;
    b.legs[1]!.filledQty = 10;
    const r = deriveEvents({ ...base, order: ord(), brokerOrder: b, position: null });
    expect(r.events.map((e) => e.type)).toEqual(["ENTRY_FILLED", "EXIT_FILLED"]);
    expect(r.events[1]).toMatchObject({ reason: "STOP", exitPrice: 96 });
  });
  it("never infers a manual close while a leg is still live", () => {
    const r = deriveEvents({
      ...base,
      order: ord({ status: "OPEN", filledQty: 10, openedAt: NOW.toISOString() }),
      brokerOrder: bo(),
      position: null,
    });
    expect(r.events.some((e) => e.type === "EXIT_FILLED")).toBe(false);
  });
  it("time exit after the max hold time", () => {
    const r = deriveEvents({
      ...base,
      order: ord({ status: "OPEN", filledQty: 10, openedAt: "2026-03-04T11:30:00Z" }),
      brokerOrder: bo(),
      position: pos,
    });
    expect(r.actions).toEqual([{ type: "FLATTEN", reason: "TIME" }]);
  });
  it("unfilled entry that expired -> EXPIRED; PENDING never seen by broker -> failed after grace", () => {
    expect(
      deriveEvents({
        ...base,
        order: ord(),
        brokerOrder: bo({ status: "expired", filledQty: 0, avgFillPrice: null }),
        position: null,
      }).events.map((e) => e.type),
    ).toEqual(["ENTRY_EXPIRED"]);
    expect(
      deriveEvents({
        ...base,
        order: ord({ status: "PENDING", createdAt: "2026-03-04T14:00:00Z" }),
        brokerOrder: null,
        position: null,
      }).events[0]!.type,
    ).toBe("SUBMIT_FAILED");
    expect(
      deriveEvents({
        ...base,
        order: ord({ status: "PENDING" }),
        brokerOrder: null,
        position: null,
      }).events,
    ).toEqual([]);
  });
});

describe("engine flow (fake broker + memory store)", () => {
  function rig(over: Partial<ExecutionSettings> = {}) {
    const broker = new FakeBroker("paper");
    const store = new MemoryStore(() => NOW);
    store.addUser("u1", over);
    const engine = createEngine({ broker, store, now: () => NOW });
    return { broker, store, engine };
  }
  it("places a bracket order, fills, then closes at target with P&L", async () => {
    const { broker, store, engine } = rig();
    const s = store.addSetup({ createdAt: NOW.toISOString() });
    const r = await engine.place("u1", s.id);
    expect(r.ok).toBe(true);
    const cid = `tm-paper-${s.id}`;
    expect(broker.orders.get(cid)!.req).toMatchObject({
      side: "LONG",
      stopPrice: 96,
      takePrice: 108,
    });
    broker.fill(cid, 100.1);
    await engine.reconcile("u1");
    expect(store.orders[0]).toMatchObject({ status: "OPEN", entryPrice: 100.1 });
    broker.hitLeg(cid, "take", 108);
    await engine.reconcile("u1");
    expect(store.orders[0]).toMatchObject({
      status: "CLOSED",
      exitReason: "TARGET",
      realizedPnl: Math.round((108 - 100.1) * store.orders[0]!.qty * 100) / 100,
    });
    expect(store.notes.some((n) => n.startsWith("Closed"))).toBe(true);
  });
  it("is idempotent: the same setup cannot be ordered twice", async () => {
    const { store, engine, broker } = rig();
    const s = store.addSetup();
    expect((await engine.place("u1", s.id)).ok).toBe(true);
    const again = await engine.place("u1", s.id);
    expect(again).toMatchObject({ ok: false });
    expect(broker.orders.size).toBe(1);
  });
  it("a blocked gate sends nothing to the broker and is logged", async () => {
    const { store, engine, broker } = rig();
    broker.isOpen = false;
    const s = store.addSetup();
    const r = await engine.place("u1", s.id);
    expect(r).toMatchObject({ ok: false, code: "GATE_BLOCKED" });
    expect(broker.orders.size).toBe(0);
    expect(store.events.some((e) => e.kind === "GATE_BLOCKED")).toBe(true);
  });
  it("broker rejection marks the order REJECTED", async () => {
    const { store, engine, broker } = rig();
    broker.failNextSubmit = new BrokerError("rejected", "insufficient buying power", 403);
    const s = store.addSetup();
    expect(await engine.place("u1", s.id)).toMatchObject({ ok: false, code: "BROKER_REJECTED" });
    expect(store.orders[0]!.status).toBe("REJECTED");
  });
  it("timeout where the order DID land: found by client id, not resubmitted", async () => {
    const { store, engine, broker } = rig();
    broker.failNextSubmit = new BrokerError("ambiguous", "timeout (landed)");
    const s = store.addSetup();
    const r = await engine.place("u1", s.id);
    expect(r.ok).toBe(true);
    expect(store.orders[0]!.status).toBe("SUBMITTED");
    expect(broker.orders.size).toBe(1);
  });
  it("timeout where it did NOT land: stays PENDING, reconcile fails it after the grace period", async () => {
    const broker = new FakeBroker("paper");
    let t = NOW;
    const store = new MemoryStore(() => t);
    store.addUser("u1");
    const engine = createEngine({ broker, store, now: () => t });
    broker.failNextSubmit = new BrokerError("ambiguous", "timeout");
    const s = store.addSetup({ createdAt: NOW.toISOString() });
    const r = await engine.place("u1", s.id);
    expect(r).toMatchObject({ ok: true, warning: expect.any(String) });
    expect(store.orders[0]!.status).toBe("PENDING");
    t = new Date(NOW.getTime() + 5 * 60_000);
    await engine.reconcile("u1");
    expect(store.orders[0]!.status).toBe("REJECTED");
  });
  it("flattens a position whose stop disappeared", async () => {
    const { store, engine, broker } = rig();
    const s = store.addSetup();
    await engine.place("u1", s.id);
    const cid = `tm-paper-${s.id}`;
    broker.fill(cid, 100);
    await engine.reconcile("u1");
    broker.dropStop(cid);
    const sum = await engine.reconcile("u1");
    expect(sum.flattened).toBe(1);
    expect(broker.closed).toEqual(["AAPL"]);
    expect(store.notes.some((n) => n.includes("no live stop"))).toBe(true);
    await engine.reconcile("u1");
    expect(store.orders[0]).toMatchObject({ status: "CLOSED", exitReason: "UNPROTECTED" });
  });
  it("kill switch cancels working entries, flattens only our positions, and blocks new orders", async () => {
    const { store, engine, broker } = rig();
    const a = store.addSetup({ ticker: "AAPL" }),
      b = store.addSetup({ ticker: "MSFT" });
    await engine.place("u1", a.id);
    await engine.place("u1", b.id);
    broker.fill(`tm-paper-${a.id}`, 100);
    await engine.reconcile("u1");
    broker.positions.push({ symbol: "TSLA", qty: 5, avgEntryPrice: 200 }); // user's own holding
    await engine.killSwitch("u1", "test");
    expect(broker.closed).toEqual(["AAPL"]);
    expect(broker.closed).not.toContain("TSLA");
    expect(store.orders.find((o) => o.ticker === "MSFT")!.status).toBe("CANCELED");
    expect(store.settings.get("u1")!.killSwitch).toBe(true);
    const c = store.addSetup({ ticker: "NVDA" });
    expect(await engine.place("u1", c.id)).toMatchObject({ ok: false, code: "GATE_BLOCKED" });
  });
  it("reports orphan positions once and never touches them", async () => {
    const { engine, broker, store } = rig();
    broker.positions.push({ symbol: "TSLA", qty: 5, avgEntryPrice: 200 });
    await engine.reconcile("u1");
    await engine.reconcile("u1");
    expect(store.events.filter((e) => e.kind === "ORPHAN_POSITION")).toHaveLength(1);
    expect(broker.closed).toEqual([]);
  });
  it("a concurrent update causes a skipped write, not a corrupted state", async () => {
    const { store, engine, broker } = rig();
    const s = store.addSetup();
    await engine.place("u1", s.id);
    broker.fill(`tm-paper-${s.id}`, 100);
    const orig = store.updateOrder.bind(store);
    store.updateOrder = async () => null; // simulate losing the race
    await engine.reconcile("u1");
    store.updateOrder = orig;
    expect(store.orders[0]!.status).toBe("SUBMITTED");
    expect(store.events.some((e) => e.kind === "VERSION_CONFLICT")).toBe(true);
    await engine.reconcile("u1");
    expect(store.orders[0]!.status).toBe("OPEN");
  });
});

describe("alpaca adapter", () => {
  const env = { ALPACA_PAPER_KEY_ID: "k", ALPACA_PAPER_SECRET: "s" };
  const mk = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
    new AlpacaBroker("paper", env, (async (u: string, i: RequestInit) =>
      handler(u, i)) as unknown as typeof fetch);
  it("refuses live without the server-side unlock and without live keys", () => {
    expect(
      () => new AlpacaBroker("live", { ALPACA_LIVE_KEY_ID: "k", ALPACA_LIVE_SECRET: "s" }),
    ).toThrow(/locked/);
    expect(
      () =>
        new AlpacaBroker("live", {
          ALPACA_ALLOW_LIVE: "1",
          ALPACA_PAPER_KEY_ID: "k",
          ALPACA_PAPER_SECRET: "s",
        }),
    ).toThrow(/ALPACA_LIVE/);
  });
  it("sends a bracket order with stop and target attached", async () => {
    let body: Record<string, unknown> = {};
    let url = "";
    const b = mk((u, i) => {
      url = u;
      body = JSON.parse(i.body as string);
      return Response.json({ id: "abc" });
    });
    expect(
      await b.submitBracketOrder({
        clientOrderId: "c1",
        symbol: "AAPL",
        side: "LONG",
        qty: 10,
        limitPrice: 100.1,
        stopPrice: 96,
        takePrice: 108,
      }),
    ).toEqual({ brokerOrderId: "abc" });
    expect(url).toContain("paper-api.alpaca.markets");
    expect(body).toMatchObject({
      order_class: "bracket",
      side: "buy",
      type: "limit",
      client_order_id: "c1",
      take_profit: { limit_price: "108" },
      stop_loss: { stop_price: "96" },
    });
  });
  it("classifies errors: 422 rejected, 403 auth, 500 / network ambiguous", async () => {
    const req = {
      clientOrderId: "c",
      symbol: "A",
      side: "LONG" as const,
      qty: 1,
      limitPrice: 2,
      stopPrice: 1,
      takePrice: 3,
    };
    await expect(
      mk(() => Response.json({ message: "bad" }, { status: 422 })).submitBracketOrder(req),
    ).rejects.toMatchObject({ kind: "rejected" });
    await expect(
      mk(() => Response.json({ message: "no" }, { status: 403 })).submitBracketOrder(req),
    ).rejects.toMatchObject({ kind: "auth" });
    await expect(
      mk(() => new Response("oops", { status: 503 })).submitBracketOrder(req),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    await expect(
      mk(() => {
        throw new Error("ECONNRESET");
      }).submitBracketOrder(req),
    ).rejects.toMatchObject({ kind: "ambiguous" });
  });
  it("maps statuses and bracket legs", () => {
    expect(["new", "held", "accepted"].map(mapStatus)).toEqual(["working", "working", "working"]);
    expect(mapStatus("pending_cancel")).toBe("canceled");
    const o = mapOrder({
      id: "1",
      client_order_id: "c",
      symbol: "AAPL",
      status: "filled",
      qty: "10",
      filled_qty: "10",
      filled_avg_price: "100.05",
      legs: [
        {
          id: "t",
          client_order_id: "",
          symbol: "AAPL",
          status: "new",
          qty: "10",
          filled_qty: "0",
          filled_avg_price: null,
          type: "limit",
        },
        {
          id: "s",
          client_order_id: "",
          symbol: "AAPL",
          status: "filled",
          qty: "10",
          filled_qty: "10",
          filled_avg_price: "96",
          type: "stop",
        },
      ],
    });
    expect(o.legs.map((l) => [l.kind, l.status])).toEqual([
      ["take", "working"],
      ["stop", "filled"],
    ]);
    expect(o.avgFillPrice).toBe(100.05);
  });
  it("fetches nested legs when the by-client-id response omits them, and returns null on 404", async () => {
    const calls: string[] = [];
    const b = mk((u) => {
      calls.push(u);
      if (u.includes("by_client_order_id"))
        return Response.json({
          id: "1",
          client_order_id: "c",
          symbol: "A",
          status: "new",
          qty: "1",
          filled_qty: "0",
          filled_avg_price: null,
          order_class: "bracket",
        });
      return Response.json({
        id: "1",
        client_order_id: "c",
        symbol: "A",
        status: "new",
        qty: "1",
        filled_qty: "0",
        filled_avg_price: null,
        legs: [
          {
            id: "s",
            status: "held",
            type: "stop",
            qty: "1",
            filled_qty: "0",
            filled_avg_price: null,
            client_order_id: "",
            symbol: "A",
          },
        ],
      });
    });
    expect((await b.getOrderByClientId("c"))!.legs).toHaveLength(1);
    expect(calls[1]).toContain("nested=true");
    expect(
      await mk(() => Response.json({ message: "nf" }, { status: 404 })).getOrderByClientId("x"),
    ).toBeNull();
  });
});
