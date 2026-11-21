import type { Cents, ISODate, MonthKey } from "./types";

export function toCents(dollars: number | string): Cents {
  const n = typeof dollars === "string" ? parseFloat(dollars.replace(/[$,\s]/g, "")) : dollars;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${dollars}`);
  return Math.round(n * 100);
}

export function formatCents(c: Cents, opts: { sign?: boolean; noCents?: boolean } = {}): string {
  const abs = Math.abs(c) / 100;
  const s = abs.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.noCents ? 0 : 2,
    maximumFractionDigits: opts.noCents ? 0 : 2,
  });
  if (c < 0) return `-${s}`;
  return opts.sign && c > 0 ? `+${s}` : s;
}

export function sum(xs: Cents[]): Cents {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

/** Split `total` into integer parts proportional to `weights`, with parts summing exactly to total (largest remainder). */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (wsum <= 0) throw new Error("weights must sum to > 0");
  const raw = weights.map((w) => (total * w) / wsum);
  const floored = raw.map((r) => Math.trunc(r));
  let remainder = total - sum(floored);
  const order = raw
    .map((r, i) => ({ i, frac: Math.abs(r - Math.trunc(r)) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = remainder >= 0 ? 1 : -1;
  for (let k = 0; remainder !== 0; k = (k + 1) % order.length) {
    floored[order[k]!.i]! += step;
    remainder -= step;
  }
  return floored;
}

// ---------- Dates (calendar math in UTC to avoid DST surprises) ----------

export function parseDate(d: ISODate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!));
}

export function fmtDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const dt = parseDate(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmtDate(dt);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

export function monthKey(d: ISODate): MonthKey {
  return d.slice(0, 7);
}

export function monthStart(m: MonthKey): ISODate {
  return `${m}-01`;
}

export function daysInMonth(m: MonthKey): number {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y!, mo!, 0)).getUTCDate();
}

export function monthEnd(m: MonthKey): ISODate {
  return `${m}-${String(daysInMonth(m)).padStart(2, "0")}`;
}

export function addMonths(m: MonthKey, n: number): MonthKey {
  const [y, mo] = m.split("-").map(Number);
  const idx = y! * 12 + (mo! - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Same day-of-month n months later, clamped to month end (Jan 31 + 1 = Feb 28/29). */
export function addMonthsToDate(d: ISODate, n: number): ISODate {
  const m = addMonths(monthKey(d), n);
  const day = Math.min(Number(d.slice(8, 10)), daysInMonth(m));
  return `${m}-${String(day).padStart(2, "0")}`;
}

/** Whole months from a to b (b later), counting partial current month as 1 if b is in a later month. */
export function monthsBetween(a: MonthKey, b: MonthKey): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by! - ay!) * 12 + (bm! - am!);
}

export function inRange(d: ISODate, start: ISODate, end: ISODate): boolean {
  return d >= start && d <= end;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}
