// Autopilot: once per bar close, scan the watchlist and hand every READY setup to the engine (which applies the full risk gate).
// Runs from a 1-minute cron. A scan is split into small batches (cursor persisted per bar) so one serverless call never has
// to analyse the whole watchlist, and a given bar is never scanned twice.
import type { ExecutionEngine } from "./engine";
import type { BrokerAdapter } from "./broker";
import type { AutopilotStore, Store } from "./store";
import { TF_MINUTES } from "./time";

export type AnalyzeResult =
  | { kind: "setup"; setupId: string }
  | { kind: "none"; reason: string }
  | { kind: "error"; message: string };

export interface AutopilotDeps {
  engine: ExecutionEngine;
  store: Store & AutopilotStore;
  broker: Pick<BrokerAdapter, "getClock">;
  /** Deterministic analysis of one ticker; persists and returns a READY setup, or says why there is none. No AI. */
  analyze: (userId: string, ticker: string, timeframe: string) => Promise<AnalyzeResult>;
  now?: () => Date;
  batchSize?: number; // tickers analysed per tick
  settleSec?: number; // wait this long after a bar closes so the data provider has published it
  maxWatchlist?: number;
}

/** Gate failures that make every further order this bar pointless: stop scanning instead of spending data calls. */
export const STOP_CODES = new Set([
  "KILL_SWITCH",
  "MODE_OFF",
  "MARKET_CLOSED",
  "NEAR_CLOSE",
  "AVOID_OPEN",
  "CLOCK_UNKNOWN",
  "DAILY_LOSS",
  "MAX_TRADES_DAY",
  "LOSS_STREAK",
  "MAX_POSITIONS",
  "ACCOUNT_BLOCKED",
  "LIVE_NOT_ARMED",
]);

export type TickResult =
  | { ran: false; reason: string }
  | { ran: true; barId: number; analysed: number; setups: number; placed: number; done: boolean };

export function createAutopilot(d: AutopilotDeps) {
  const now = d.now ?? (() => new Date());
  const batchSize = d.batchSize ?? 4,
    settleSec = d.settleSec ?? 20,
    maxWatchlist = d.maxWatchlist ?? 25;

  async function tick(userId: string): Promise<TickResult> {
    const s = await d.store.getSettings(userId);
    if (!s || !s.autopilotEnabled) return { ran: false, reason: "autopilot_off" };
    if (s.mode === "off" || s.killSwitch) return { ran: false, reason: "execution_off" };
    const clock = await d.broker.getClock();
    if (!clock.isOpen) return { ran: false, reason: "market_closed" };

    const tf = s.autopilotTimeframe,
      tfMs = (TF_MINUTES[tf] ?? 15) * 60_000,
      t = now().getTime();
    const barId = Math.floor(t / tfMs); // 5m/15m bars align with the epoch, and the 09:30 ET open is on a 15-minute boundary
    if (t - barId * tfMs < settleSec * 1000) return { ran: false, reason: "settling" };

    const existing = await d.store.getRun(userId, barId);
    if (existing?.status === "done") return { ran: false, reason: "bar_already_scanned" };

    const tickers = (await d.store.watchlist(userId, tf)).slice(0, maxWatchlist);
    const run = existing ?? {
      userId,
      barId,
      timeframe: tf,
      status: "running" as const,
      cursor: 0,
      tickersTotal: tickers.length,
      setupsFound: 0,
      ordersPlaced: 0,
      skipped: {},
      errors: [],
    };
    const active = new Set((await d.store.activeOrders(userId, s.mode)).map((o) => o.ticker));
    let analysed = 0,
      setups = 0,
      placed = 0,
      halted = false;

    for (const ticker of tickers.slice(run.cursor, run.cursor + batchSize)) {
      run.cursor++;
      if (active.has(ticker)) {
        run.skipped[ticker] = "already in a position";
        continue;
      }
      let res: AnalyzeResult;
      try {
        res = await d.analyze(userId, ticker, tf);
      } catch (e) {
        res = { kind: "error", message: (e as Error).message };
      }
      analysed++;
      if (res.kind === "error") {
        run.errors.push(`${ticker}: ${res.message}`.slice(0, 200));
        continue;
      }
      if (res.kind === "none") {
        run.skipped[ticker] = res.reason.slice(0, 120);
        continue;
      }
      setups++;
      run.setupsFound++;
      const r = await d.engine.place(userId, res.setupId);
      if (r.ok) {
        placed++;
        run.ordersPlaced++;
        active.add(ticker);
        continue;
      }
      run.skipped[ticker] = r.failures ? r.failures.map((f) => f.code).join(",") : r.code;
      if (r.failures?.some((f) => STOP_CODES.has(f.code))) {
        halted = true;
        break;
      }
    }

    const done = halted || run.cursor >= tickers.length;
    run.status = done ? "done" : "running";
    await d.store.saveRun(run);
    return { ran: true, barId, analysed, setups, placed, done };
  }

  return { tick };
}
