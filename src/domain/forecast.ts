import { addDays } from "./money";
import { occurrencesBetween, type RecurringSeries } from "./recurring";
import type { Cents, ISODate } from "./types";

/**
 * Cash-flow forecast for a cash account: start from today's balance, add
 * expected recurring inflows/outflows and scheduled one-offs (e.g. sinking-fund
 * bills), and subtract average daily flexible spend. Flags the first day the
 * balance dips below a floor.
 */

export interface ScheduledItem {
  date: ISODate;
  amount: Cents; // signed
  label: string;
}

export interface ForecastDay {
  date: ISODate;
  balance: Cents;
  events: ScheduledItem[];
}

export interface ForecastResult {
  days: ForecastDay[];
  lowest: { date: ISODate; balance: Cents };
  firstBelowFloor: { date: ISODate; balance: Cents; trigger: ScheduledItem | null } | null;
}

export function forecastAccount(params: {
  accountId: string;
  startBalance: Cents;
  today: ISODate;
  horizonDays: number;
  recurring: RecurringSeries[];
  scheduled?: ScheduledItem[];
  /** Average daily discretionary spend charged to this account (positive). */
  dailyFlexSpend?: Cents;
  floor?: Cents;
}): ForecastResult {
  const { accountId, today, horizonDays } = params;
  const end = addDays(today, horizonDays);
  const events = new Map<ISODate, ScheduledItem[]>();
  const push = (e: ScheduledItem) => (events.get(e.date) ?? events.set(e.date, []).get(e.date)!).push(e);

  for (const s of params.recurring) {
    if (s.accountId !== accountId) continue;
    // Start from tomorrow: today's activity is already in the balance.
    for (const d of occurrencesBetween(s, addDays(today, 1), end)) push({ date: d, amount: s.typicalAmount, label: s.merchant });
  }
  for (const e of params.scheduled ?? []) if (e.date > today && e.date <= end) push(e);

  const days: ForecastDay[] = [];
  let bal = params.startBalance;
  let lowest = { date: today, balance: bal };
  let first: ForecastResult["firstBelowFloor"] = null;
  const floor = params.floor ?? 0;
  const flex = params.dailyFlexSpend ?? 0;
  for (let i = 1; i <= horizonDays; i++) {
    const d = addDays(today, i);
    const ev = (events.get(d) ?? []).sort((a, b) => a.amount - b.amount);
    let trigger: ScheduledItem | null = null;
    for (const e of ev) {
      bal += e.amount;
      if (!first && bal < floor && e.amount < 0) trigger = e;
    }
    bal -= flex;
    days.push({ date: d, balance: bal, events: ev });
    if (bal < lowest.balance) lowest = { date: d, balance: bal };
    if (!first && bal < floor) first = { date: d, balance: bal, trigger };
  }
  return { days, lowest, firstBelowFloor: first };
}
