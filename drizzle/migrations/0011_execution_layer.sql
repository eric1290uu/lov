-- Execution layer: broker orders, per-user execution settings, audit log.
-- All writes go through server code with the admin client (same rule as `analyses`); users can only read their rows.

CREATE TABLE public.execution_settings (
  user_id uuid PRIMARY KEY,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'paper', 'live')),
  kill_switch boolean NOT NULL DEFAULT false,
  live_armed_at timestamptz,                       -- live orders need an arm within the last 24h
  allow_short boolean NOT NULL DEFAULT false,
  max_open_positions integer NOT NULL DEFAULT 5 CHECK (max_open_positions BETWEEN 1 AND 50),
  max_position_pct numeric NOT NULL DEFAULT 20 CHECK (max_position_pct > 0 AND max_position_pct <= 100),
  max_daily_loss_pct numeric NOT NULL DEFAULT 2 CHECK (max_daily_loss_pct > 0 AND max_daily_loss_pct <= 100),
  min_rr numeric NOT NULL DEFAULT 1.5 CHECK (min_rr >= 1),
  max_setup_age_min integer NOT NULL DEFAULT 20 CHECK (max_setup_age_min BETWEEN 1 AND 240),
  entry_collar_bps numeric NOT NULL DEFAULT 10 CHECK (entry_collar_bps BETWEEN 0 AND 100),
  max_hold_min integer NOT NULL DEFAULT 180 CHECK (max_hold_min BETWEEN 5 AND 390),
  flatten_min_before_close integer NOT NULL DEFAULT 15 CHECK (flatten_min_before_close BETWEEN 1 AND 120), -- no overnight positions
  flatten_unprotected boolean NOT NULL DEFAULT true,
  -- intraday controls
  entry_expiry_bars integer NOT NULL DEFAULT 2 CHECK (entry_expiry_bars BETWEEN 1 AND 10),
  avoid_open_min integer NOT NULL DEFAULT 10 CHECK (avoid_open_min BETWEEN 0 AND 60),
  max_trades_per_day integer NOT NULL DEFAULT 10 CHECK (max_trades_per_day BETWEEN 1 AND 100),
  max_consecutive_losses integer NOT NULL DEFAULT 3 CHECK (max_consecutive_losses BETWEEN 1 AND 20),
  ticker_cooldown_min integer NOT NULL DEFAULT 30 CHECK (ticker_cooldown_min BETWEEN 0 AND 600),
  est_cost_bps numeric NOT NULL DEFAULT 8 CHECK (est_cost_bps >= 0 AND est_cost_bps <= 100),     -- assumed round-trip cost
  min_cost_multiple numeric NOT NULL DEFAULT 4 CHECK (min_cost_multiple >= 1 AND min_cost_multiple <= 20),
  -- autopilot
  autopilot_enabled boolean NOT NULL DEFAULT false,
  autopilot_timeframe text NOT NULL DEFAULT '15m' CHECK (autopilot_timeframe IN ('5m', '15m')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.execution_settings TO authenticated;
GRANT ALL ON public.execution_settings TO service_role;
ALTER TABLE public.execution_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own execution settings select" ON public.execution_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  setup_id uuid REFERENCES public.trade_setups(id) ON DELETE SET NULL,
  ticker text NOT NULL,
  side text NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  mode text NOT NULL CHECK (mode IN ('paper', 'live')),
  broker text NOT NULL,
  client_order_id text NOT NULL UNIQUE,            -- tm-<mode>-<setup id>: one order per setup per mode, ever
  broker_order_id text,
  status text NOT NULL CHECK (status IN ('PENDING','SUBMITTED','PARTIALLY_FILLED','OPEN','CLOSED','CANCELED','REJECTED','EXPIRED','NEEDS_ATTENTION')),
  qty integer NOT NULL CHECK (qty > 0),
  limit_price numeric NOT NULL,
  stop_price numeric NOT NULL,
  take_price numeric NOT NULL,
  filled_qty integer NOT NULL DEFAULT 0,
  entry_price numeric,
  exit_price numeric,
  exit_reason text,
  exit_hint text,                                  -- why we asked the broker to flatten (TIME / KILL_SWITCH / UNPROTECTED)
  realized_pnl numeric,
  status_reason text,
  expires_at timestamptz,                          -- unfilled entries are cancelled after this
  submitted_at timestamptz,
  opened_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1,              -- optimistic concurrency: cron and user actions never overwrite each other
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one live (non-terminal) order per ticker per mode per user.
CREATE UNIQUE INDEX orders_one_active_per_ticker ON public.orders (user_id, ticker, mode)
  WHERE status IN ('PENDING','SUBMITTED','PARTIALLY_FILLED','OPEN','NEEDS_ATTENTION');
CREATE INDEX orders_user_created ON public.orders (user_id, created_at DESC);
GRANT SELECT ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own orders select" ON public.orders FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.execution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  kind text NOT NULL,
  from_status text,
  to_status text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_events_user_created ON public.execution_events (user_id, created_at DESC);
CREATE INDEX execution_events_order ON public.execution_events (order_id, created_at);
GRANT SELECT ON public.execution_events TO authenticated;
GRANT ALL ON public.execution_events TO service_role;
ALTER TABLE public.execution_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own execution events select" ON public.execution_events FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- One row per user per bar scanned by the autopilot. Lets a scan be split across cron ticks and never repeat for the same bar.
CREATE TABLE public.autopilot_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bar_id bigint NOT NULL,
  timeframe text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  cursor integer NOT NULL DEFAULT 0,
  tickers_total integer NOT NULL DEFAULT 0,
  setups_found integer NOT NULL DEFAULT 0,
  orders_placed integer NOT NULL DEFAULT 0,
  skipped jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bar_id)
);
CREATE INDEX autopilot_runs_user_created ON public.autopilot_runs (user_id, created_at DESC);
GRANT SELECT ON public.autopilot_runs TO authenticated;
GRANT ALL ON public.autopilot_runs TO service_role;
ALTER TABLE public.autopilot_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own autopilot runs select" ON public.autopilot_runs FOR SELECT TO authenticated USING (auth.uid() = user_id);
