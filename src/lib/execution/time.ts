// US-market time helpers (pure). All session maths is done in America/New_York so DST is handled by Intl, not by hand.
export const TF_MINUTES: Record<string, number> = { "5m": 5, "15m": 15, "1h": 60 };
export const INTRADAY_TFS = Object.keys(TF_MINUTES);

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function etParts(d: Date) {
  const o: Record<string, number> = {};
  for (const p of FMT.formatToParts(d)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return {
    y: o["year"]!,
    m: o["month"]!,
    d: o["day"]!,
    h: o["hour"]!,
    min: o["minute"]!,
    s: o["second"]!,
  };
}
const offsetMs = (d: Date) => {
  const p = etParts(d);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(d.getTime() / 1000) * 1000;
};

/** The UTC instant at which New York wall-clock time is y-m-d h:min. */
export function etToUtc(y: number, m: number, d: number, h: number, min: number): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const off1 = offsetMs(new Date(guess));
  let t = guess - off1;
  const off2 = offsetMs(new Date(t));
  if (off2 !== off1) t = guess - off2; // landed on the other side of a DST change
  return new Date(t);
}
export const startOfEtDay = (now: Date) => {
  const p = etParts(now);
  return etToUtc(p.y, p.m, p.d, 0, 0);
};
/** Regular session always opens 09:30 ET (half-days only close early). */
export const sessionOpenEt = (now: Date) => {
  const p = etParts(now);
  return etToUtc(p.y, p.m, p.d, 9, 30);
};
