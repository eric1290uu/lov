import { createFileRoute } from "@tanstack/react-router";

// Schedule EVERY MINUTE during the US session (cron: * 13-21 * * 1-5 UTC; this over-covers, the engine itself checks the market clock).
// Each tick reconciles with the broker first (exits, stops, end-of-day flatten), then lets the autopilot scan for entries.
// Only the cron secret is accepted, because this endpoint can move real orders. Idempotent: safe to call at any time or twice.
export const Route = createFileRoute("/api/public/hooks/execution-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authenticateCronRequest } = await import("@/integrations/supabase/cron-auth");
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;
        try {
          const { tickAll } = await import("@/lib/execution.server");
          const r = await tickAll();
          return Response.json({
            ok: r.reconciled.every((x) => x.ok) && r.autopilot.every((x) => !x.error),
            ...r,
          });
        } catch (e) {
          console.error("execution-tick failed", e);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
