// The autopilot does not run the AI news stage (cost and latency on a 5-15 minute loop). The one scheduled event that matters
// most for short-term trades, earnings, is known deterministically, so it is handled here. Breaking news is NOT assessed.
export interface AutopilotEventRisk {
  eventRisk: { level: "normal" | "elevated" | "high"; factors: string[] };
  netSentiment: { score: number | null; label: "unavailable" };
}
const DAY = 86_400_000;

export function deterministicEventRisk(
  nextEarningsDate: string | null | undefined,
  now: Date,
): AutopilotEventRisk {
  const factors = ["news not assessed by the autopilot"];
  let level: "normal" | "elevated" | "high" = "normal";
  if (!nextEarningsDate) factors.push("earnings date unknown");
  else {
    const d = Date.parse(`${nextEarningsDate}T00:00:00Z`);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const days = Math.round((d - today) / DAY);
    if (Number.isNaN(days)) factors.push("earnings date unreadable");
    else if (days >= -1 && days <= 1) {
      level = "high";
      factors.push(`earnings ${days < 0 ? "just reported" : days === 0 ? "today" : "tomorrow"}`);
    } else if (days > 1 && days <= 3) {
      level = "elevated";
      factors.push(`earnings in ${days} days`);
    }
  }
  return { eventRisk: { level, factors }, netSentiment: { score: null, label: "unavailable" } };
}
