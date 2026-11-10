// Alpaca adapter (US equities). Paper and live use SEPARATE key pairs, so a paper key can never touch real money,
// and live additionally needs ALPACA_ALLOW_LIVE=1 on the server.
import {
  BrokerError,
  type BracketRequest,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerLeg,
  type BrokerOrder,
  type BrokerOrderStatus,
  type BrokerPosition,
} from "./broker";
import type { BrokerMode } from "./types";

const BASE = {
  paper: "https://paper-api.alpaca.markets",
  live: "https://api.alpaca.markets",
} as const;
const DATA = "https://data.alpaca.markets";
const num = (v: unknown): number => (v == null || v === "" ? NaN : Number(v));
const numOrNull = (v: unknown): number | null => {
  const n = num(v);
  return Number.isFinite(n) ? n : null;
};

export function mapStatus(s: string): BrokerOrderStatus {
  switch (s) {
    case "filled":
      return "filled";
    case "partially_filled":
      return "partially_filled";
    case "canceled":
    case "pending_cancel":
    case "stopped":
    case "suspended":
      return "canceled";
    case "expired":
    case "done_for_day":
      return "expired";
    case "rejected":
      return "rejected";
    default:
      return "working"; // new, accepted, pending_new, held, accepted_for_bidding, calculated, replaced, pending_replace
  }
}

interface RawOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  status: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  order_type?: string;
  type?: string;
  order_class?: string;
  legs?: RawOrder[] | null;
}

export function mapOrder(r: RawOrder): BrokerOrder {
  const legs: BrokerLeg[] = (r.legs ?? []).map((l) => ({
    id: l.id,
    kind: (l.type ?? l.order_type) === "limit" ? "take" : "stop", // bracket legs: take-profit = limit, stop-loss = stop / stop_limit
    status: mapStatus(l.status),
    filledQty: num(l.filled_qty) || 0,
    avgFillPrice: numOrNull(l.filled_avg_price),
  }));
  return {
    id: r.id,
    clientOrderId: r.client_order_id,
    symbol: r.symbol,
    status: mapStatus(r.status),
    qty: num(r.qty),
    filledQty: num(r.filled_qty) || 0,
    avgFillPrice: numOrNull(r.filled_avg_price),
    legs,
  };
}

export class AlpacaBroker implements BrokerAdapter {
  readonly name = "alpaca";
  private key: string;
  private secret: string;

  constructor(
    public readonly mode: BrokerMode,
    private env: Record<string, string | undefined> = process.env,
    private f: typeof fetch = fetch,
    private timeoutMs = 10_000,
  ) {
    if (mode === "live" && env["ALPACA_ALLOW_LIVE"] !== "1")
      throw new BrokerError(
        "auth",
        "Live trading is locked: set ALPACA_ALLOW_LIVE=1 on the server to allow it.",
      );
    const p = mode === "live" ? "ALPACA_LIVE" : "ALPACA_PAPER";
    const k = env[`${p}_KEY_ID`],
      s = env[`${p}_SECRET`];
    if (!k || !s) throw new BrokerError("auth", `Missing ${p}_KEY_ID / ${p}_SECRET.`);
    this.key = k;
    this.secret = s;
  }

  private async req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        signal: ctl.signal,
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new BrokerError("ambiguous", `network error: ${(e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
    const msg = (() => {
      try {
        return (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        return text;
      }
    })().slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new BrokerError("auth", msg, res.status);
    if (res.status === 404) throw new BrokerError("not_found", msg, res.status);
    if (res.status === 429 || res.status >= 500)
      throw new BrokerError("ambiguous", `broker ${res.status}: ${msg}`, res.status);
    throw new BrokerError("rejected", msg, res.status); // 400 / 422 etc.
  }
  private api = (path: string) => `${BASE[this.mode]}${path}`;

  async getAccount(): Promise<BrokerAccount> {
    const a = await this.req<Record<string, unknown>>("GET", this.api("/v2/account"));
    return {
      equity: num(a["equity"]),
      lastEquity: num(a["last_equity"]),
      buyingPower: num(a["buying_power"]),
      tradingBlocked: a["trading_blocked"] === true || a["account_blocked"] === true,
    };
  }
  async getClock() {
    const c = await this.req<{ is_open: boolean; next_close?: string }>(
      "GET",
      this.api("/v2/clock"),
    );
    return { isOpen: c.is_open, nextClose: c.next_close ? new Date(c.next_close) : null };
  }
  async getLastPrice(symbol: string) {
    const feed = this.env["ALPACA_DATA_FEED"] ?? "iex";
    const r = await this.req<{ trade: { p: number; t: string } }>(
      "GET",
      `${DATA}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=${feed}`,
    );
    return {
      price: r.trade.p,
      ageSec: Math.max(0, (Date.now() - new Date(r.trade.t).getTime()) / 1000),
    };
  }
  async submitBracketOrder(q: BracketRequest) {
    const o = await this.req<{ id: string }>("POST", this.api("/v2/orders"), {
      symbol: q.symbol,
      qty: String(q.qty),
      side: q.side === "LONG" ? "buy" : "sell",
      type: "limit",
      time_in_force: "day",
      limit_price: String(q.limitPrice),
      order_class: "bracket",
      client_order_id: q.clientOrderId,
      take_profit: { limit_price: String(q.takePrice) },
      stop_loss: { stop_price: String(q.stopPrice) },
    });
    return { brokerOrderId: o.id };
  }
  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    try {
      let o = await this.req<RawOrder>(
        "GET",
        this.api(
          `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        ),
      );
      if (o.order_class === "bracket" && !o.legs)
        o = await this.req<RawOrder>("GET", this.api(`/v2/orders/${o.id}?nested=true`));
      return mapOrder(o);
    } catch (e) {
      if (e instanceof BrokerError && e.kind === "not_found") return null;
      throw e;
    }
  }
  async listPositions(): Promise<BrokerPosition[]> {
    const r = await this.req<{ symbol: string; qty: string; avg_entry_price: string }[]>(
      "GET",
      this.api("/v2/positions"),
    );
    return r.map((p) => ({
      symbol: p.symbol,
      qty: num(p.qty),
      avgEntryPrice: num(p.avg_entry_price),
    }));
  }
  async cancelOrder(id: string) {
    try {
      await this.req("DELETE", this.api(`/v2/orders/${id}`));
      return true;
    } catch (e) {
      if (e instanceof BrokerError && (e.kind === "not_found" || e.status === 422)) return false;
      throw e;
    } // already terminal
  }
  async closePosition(symbol: string) {
    // Right after cancelling a bracket the shares can still be "held for orders" for a moment: retry a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.req("DELETE", this.api(`/v2/positions/${encodeURIComponent(symbol)}`));
        return;
      } catch (e) {
        if (e instanceof BrokerError && e.kind === "not_found") return; // already flat
        if (attempt >= 3 || !(e instanceof BrokerError) || e.status !== 403) throw e;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }
}
