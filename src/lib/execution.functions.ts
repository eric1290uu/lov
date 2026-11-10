import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getExecutionStateFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = context.supabase as unknown as { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const [s, o, e, r] = await Promise.all([
      sb.from("execution_settings").select("*").maybeSingle(),
      sb.from("orders").select("*").order("created_at", { ascending: false }).limit(50),
      sb.from("execution_events").select("*").order("created_at", { ascending: false }).limit(100),
      sb.from("autopilot_runs").select("*").order("created_at", { ascending: false }).limit(20),
    ]);
    return {
      settings: s.data ?? null,
      orders: o.data ?? [],
      events: e.data ?? [],
      runs: r.data ?? [],
    };
  });

export const saveExecutionSettingsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        mode: z.enum(["off", "paper"]).optional(), // live can only be set through armLiveFn
        allowShort: z.boolean().optional(),
        maxOpenPositions: z.number().int().min(1).max(50).optional(),
        maxPositionPct: z.number().gt(0).max(100).optional(),
        maxDailyLossPct: z.number().gt(0).max(100).optional(),
        minRr: z.number().min(1).max(10).optional(),
        maxSetupAgeMin: z.number().int().min(1).max(240).optional(),
        entryCollarBps: z.number().min(0).max(100).optional(),
        maxHoldMin: z.number().int().min(5).max(390).optional(),
        flattenMinBeforeClose: z.number().int().min(1).max(120).optional(),
        flattenUnprotected: z.boolean().optional(),
        entryExpiryBars: z.number().int().min(1).max(10).optional(),
        avoidOpenMin: z.number().int().min(0).max(60).optional(),
        maxTradesPerDay: z.number().int().min(1).max(100).optional(),
        maxConsecutiveLosses: z.number().int().min(1).max(20).optional(),
        tickerCooldownMin: z.number().int().min(0).max(600).optional(),
        estCostBps: z.number().min(0).max(100).optional(),
        minCostMultiple: z.number().min(1).max(20).optional(),
        autopilotEnabled: z.boolean().optional(),
        autopilotTimeframe: z.enum(["5m", "15m"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const m = await import("./execution.server");
    await m.saveSettings(context.userId, data);
    return { ok: true };
  });

export const placeOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ setupId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) =>
    (await import("./execution.server")).placeSetupOrder(context.userId, data.setupId),
  );

export const armLiveFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ confirm: z.literal("ARM LIVE TRADING") }).parse(d))
  .handler(async ({ context }) => {
    await (await import("./execution.server")).armLive(context.userId);
    return { ok: true };
  });

export const killSwitchFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => ({
    results: await (await import("./execution.server")).engageKillSwitch(context.userId, "manual"),
  }));

export const resumeExecutionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await (await import("./execution.server")).resume(context.userId);
    return { ok: true };
  });
