// In-memory broker + store for tests and dry runs. Never imported by production code paths.
import {
  BrokerError,
  type BracketRequest,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerLeg,
  type BrokerOrder,
  type BrokerPosition,
} from "./broker";
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
  DEFAULT_SETTINGS,
  isActive,
  type BrokerMode,
  type ExecutionSettings,
  type OrderRow,
  type SetupRow,
} from "./types";

export class FakeBroker implements BrokerAdapter {
  readonly name = "fake";
  orders = new Map<string, BrokerOrder & { req: BracketRequest }>();
  positions: BrokerPosition[] = [];
  account: BrokerAccount = {
    equity: 100_000,
    lastEquity: 100_000,
    buyingPower: 400_000,
    tradingBlocked: false,
  };
  isOpen = true;
  /** Matches the tests' fixed clock (2026-03-04 15:00Z = 10:00 ET): 360 minutes to the 16:00 ET close. */
  nextClose: Date | null = new Date("2026-03-04T21:00:00Z");
  price = 100;
  priceAgeSec = 1;
  failNextSubmit: BrokerError | null = null;
  closed: string[] = [];
  cancelled: string[] = [];
  private seq = 0;
  constructor(public mode: BrokerMode = "paper") {}

  async getAccount() {
    return this.account;
  }
  async getClock() {
    return { isOpen: this.isOpen, nextClose: this.nextClose };
  }
  async getLastPrice() {
    return { price: this.price, ageSec: this.priceAgeSec };
  }
  async submitBracketOrder(req: BracketRequest) {
    if (this.failNextSubmit) {
      const e = this.failNextSubmit;
      this.failNextSubmit = null;
      if (e.kind === "ambiguous" && e.message.includes("landed")) this.add(req);
      throw e;
    }
    return { brokerOrderId: this.add(req).id };
  }
  private add(req: BracketRequest) {
    const id = `b${++this.seq}`;
    const legs: BrokerLeg[] = [
      { id: `${id}-tp`, kind: "take", status: "working", filledQty: 0, avgFillPrice: null },
      { id: `${id}-sl`, kind: "stop", status: "working", filledQty: 0, avgFillPrice: null },
    ];
    const o = {
      id,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      status: "working" as const,
      qty: req.qty,
      filledQty: 0,
      avgFillPrice: null,
      legs,
      req,
    };
    this.orders.set(req.clientOrderId, o);
    return o;
  }
  async getOrderByClientId(c: string) {
    return this.orders.get(c) ?? null;
  }
  async listPositions() {
    return this.positions;
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id);
    const o = [...this.orders.values()].find((x) => x.id === id);
    if (!o) return false;
    if (o.status === "working" || o.status === "partially_filled") {
      if (o.filledQty === 0) o.status = "canceled";
    }
    o.legs.forEach((l) => {
      if (l.status === "working") l.status = "canceled";
    });
    return true;
  }
  async closePosition(symbol: string) {
    this.closed.push(symbol);
    this.positions = this.positions.filter((p) => p.symbol !== symbol);
  }

  // --- test controls
  fill(clientId: string, price: number, qty?: number) {
    const o = this.orders.get(clientId)!;
    const q = qty ?? o.qty;
    o.filledQty = q;
    o.avgFillPrice = price;
    o.status = q >= o.qty ? "filled" : "partially_filled";
    this.positions = this.positions.filter((p) => p.symbol !== o.symbol);
    this.positions.push({
      symbol: o.symbol,
      qty: o.req.side === "LONG" ? q : -q,
      avgEntryPrice: price,
    });
  }
  hitLeg(clientId: string, kind: "stop" | "take", price: number) {
    const o = this.orders.get(clientId)!;
    const l = o.legs.find((x) => x.kind === kind)!;
    l.status = "filled";
    l.filledQty = o.filledQty;
    l.avgFillPrice = price;
    o.legs.filter((x) => x !== l).forEach((x) => (x.status = "canceled"));
    this.positions = this.positions.filter((p) => p.symbol !== o.symbol);
  }
  dropStop(clientId: string) {
    this.orders.get(clientId)!.legs.find((l) => l.kind === "stop")!.status = "canceled";
  }
}

export class MemoryStore implements Store, AutopilotStore {
  settings = new Map<string, ExecutionSettings>();
  setups = new Map<string, SetupRow>();
  orders: OrderRow[] = [];
  events: (EventLog & { at: number })[] = [];
  notes: string[] = [];
  watch = new Map<string, string[]>();
  runs: AutopilotRun[] = [];
  private seq = 0;
  constructor(private now: () => Date = () => new Date()) {}

  async getSettings(u: string) {
    return this.settings.get(u) ?? null;
  }
  async setKillSwitch(u: string, on: boolean) {
    const s = this.settings.get(u);
    if (s) s.killSwitch = on;
  }
  async getSetup(u: string, id: string) {
    const s = this.setups.get(id);
    return s && s.userId === u ? s : null;
  }
  async activeOrders(u: string, m: BrokerMode) {
    return this.orders
      .filter((o) => o.userId === u && o.mode === m && isActive(o.status))
      .map((o) => ({ ...o }));
  }
  async insertOrder(n: NewOrder) {
    if (this.orders.some((o) => o.clientOrderId === n.clientOrderId))
      throw new DuplicateOrderError();
    if (
      this.orders.some(
        (o) =>
          o.userId === n.userId && o.ticker === n.ticker && o.mode === n.mode && isActive(o.status),
      )
    )
      throw new DuplicateOrderError();
    const row: OrderRow = {
      id: `o${++this.seq}`,
      ...n,
      setupId: n.setupId,
      brokerOrderId: null,
      status: "PENDING",
      filledQty: 0,
      entryPrice: null,
      exitPrice: null,
      exitReason: null,
      exitHint: null,
      realizedPnl: null,
      statusReason: null,
      submittedAt: null,
      openedAt: null,
      closedAt: null,
      version: 1,
      createdAt: this.now().toISOString(),
    };
    this.orders.push(row);
    return { ...row };
  }
  async updateOrder(id: string, v: number, patch: Patch) {
    const o = this.orders.find((x) => x.id === id);
    if (!o || o.version !== v) return null;
    Object.assign(o, patch, { version: v + 1 });
    return { ...o };
  }
  async tradesSince(u: string, m: BrokerMode, since: string) {
    return this.orders.filter(
      (o) =>
        o.userId === u &&
        o.mode === m &&
        o.createdAt >= since &&
        !["REJECTED", "CANCELED", "EXPIRED"].includes(o.status),
    ).length;
  }
  async closedSince(u: string, m: BrokerMode, since: string) {
    return this.orders
      .filter(
        (o) =>
          o.userId === u &&
          o.mode === m &&
          o.status === "CLOSED" &&
          o.closedAt != null &&
          o.closedAt >= since,
      )
      .sort((a, b) => (b.closedAt! > a.closedAt! ? 1 : -1))
      .map((o) => ({ ticker: o.ticker, realizedPnl: o.realizedPnl, closedAt: o.closedAt! }));
  }
  async autopilotUsers() {
    return [...this.settings.values()]
      .filter((s) => s.autopilotEnabled && s.mode !== "off" && !s.killSwitch)
      .map((s) => s.userId);
  }
  async watchlist(u: string) {
    return this.watch.get(u) ?? [];
  }
  async getRun(u: string, barId: number) {
    const r = this.runs.find((x) => x.userId === u && x.barId === barId);
    return r ? { ...r } : null;
  }
  async saveRun(r: AutopilotRun) {
    const i = this.runs.findIndex((x) => x.userId === r.userId && x.barId === r.barId);
    if (i >= 0) this.runs[i] = { ...r };
    else this.runs.push({ ...r });
  }
  async logEvent(e: EventLog) {
    this.events.push({ ...e, at: this.now().getTime() });
  }
  async hasRecentEvent(_u: string, kind: string, key: string, withinMin: number) {
    const since = this.now().getTime() - withinMin * 60_000;
    return this.events.some(
      (e) => e.kind === kind && e.at >= since && (e.detail as { key?: string })?.key === key,
    );
  }
  async notify(_u: string, text: string) {
    this.notes.push(text);
  }
  async reconcileTargets() {
    return [...this.settings.values()]
      .filter((s) => s.mode !== "off")
      .map((s) => ({ userId: s.userId, mode: s.mode as BrokerMode }));
  }

  // --- fixtures
  addUser(userId: string, over: Partial<ExecutionSettings> = {}) {
    this.settings.set(userId, { userId, ...DEFAULT_SETTINGS, mode: "paper", ...over });
  }
  addSetup(over: Partial<SetupRow> = {}): SetupRow {
    const s: SetupRow = {
      id: `s${++this.seq}`,
      userId: "u1",
      ticker: "AAPL",
      side: "LONG",
      status: "READY",
      timeframe: "15m",
      createdAt: this.now().toISOString(),
      entryZoneLow: 99,
      entryZoneHigh: 101,
      preferredEntry: 100,
      stopLoss: 96,
      takeProfit1: 108,
      positionShares: 50,
      riskPercent: 1,
      accountSize: 10_000,
      ...over,
    };
    this.setups.set(s.id, s);
    return s;
  }
}
