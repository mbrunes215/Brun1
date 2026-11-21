import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema, type DB } from "@/db";
import { addDays, addMonths, daysBetween, formatCents } from "@/domain/money";
import { missedCharges, occurrencesBetween, priceIncrease } from "@/domain/recurring";
import { utilization } from "@/domain/debt";
import { cashForecast, monthBudget, recurringSeries } from "./insights";
import { getHousehold, loadAccounts, loadTxnRows, toTxn } from "./repo";
import { todayIn } from "./sync";
import { newId } from "./crypto";

/** Rule-based alerts. Each has a dedupe key so it fires once per relevant period. */

function emit(db: DB, householdId: string, kind: string, title: string, body: string, dedupeKey: string, userSlot: "A" | "B" | null = null): boolean {
  const exists = db.select({ id: schema.alerts.id }).from(schema.alerts).where(and(eq(schema.alerts.householdId, householdId), eq(schema.alerts.dedupeKey, dedupeKey))).get();
  if (exists) return false;
  db.insert(schema.alerts).values({ id: newId(), householdId, kind, title, body, dedupeKey, userSlot }).run();
  return true;
}

export function runAlerts(householdId: string, db: DB = getDb()): number {
  const hh = getHousehold(householdId, db);
  const today = todayIn(hh.timezone);
  const month = today.slice(0, 7);
  const s = hh.settings;
  let n = 0;
  const fire = (kind: string, title: string, body: string, key: string, slot: "A" | "B" | null = null) => {
    if (emit(db, householdId, kind, title, body, key, slot)) n++;
  };

  // Sync health
  for (const c of db.select().from(schema.connections).where(eq(schema.connections.householdId, householdId)).all()) {
    const stale = !c.lastSyncedAt || Date.now() - Date.parse(c.lastSyncedAt) > 36 * 3600_000;
    if (c.lastError || stale) fire("sync", "Bank sync needs attention", c.lastError ?? "No successful sync in over a day.", `sync:${c.id}:${today}`);
  }

  // Large transactions (last 3 days)
  const threshold = (s.largeTxnThreshold as number | undefined) ?? 50000;
  for (const t of loadTxnRows(householdId, { start: addDays(today, -3) }, db)) {
    if (t.isTransfer || t.amount >= 0 || -t.amount < threshold || t.isPrivate) continue;
    fire("large_txn", `Large purchase: ${formatCents(-t.amount)}`, `${t.merchant ?? t.payeeRaw} on ${t.date}`, `large:${t.id}`);
  }

  // Budget pace
  const mb = monthBudget(householdId, month, today, "household", db);
  if (mb.hasPlan) {
    const f = mb.result.flex;
    const budget = f.budgeted + f.carryIn;
    if (budget > 0 && f.spent >= budget) fire("budget", "Flex budget used up", `${formatCents(f.spent)} spent of ${formatCents(budget)} this month.`, `flex100:${month}`);
    else if (budget > 0 && f.spent >= budget * 0.8) fire("budget", "80% of flex budget used", `${formatCents(budget - f.spent)} left for ${f.pace?.daysLeft ?? 0} days.`, `flex80:${month}`);
  }

  // Recurring: bills due soon, missed, price increases
  const series = recurringSeries(householdId, today, db).filter((x) => x.status !== "cancelled");
  for (const x of series.filter((x) => x.direction === "outflow")) {
    for (const d of occurrencesBetween(x, today, addDays(today, 3))) fire("bill_due", `${x.label} due ${d}`, `About ${formatCents(-x.typicalAmount)}.`, `due:${x.key}:${d}`);
  }
  for (const x of missedCharges(series, today)) fire("missed", `${x.merchant} didn't show up`, `Expected around ${x.nextExpected}. Card change or failed autopay?`, `missed:${x.key}:${x.nextExpected}`);
  const recent = loadTxnRows(householdId, { start: addDays(today, -400) }, db).map((r) => toTxn(r));
  for (const x of series) {
    const inc = priceIncrease(x, recent);
    if (inc) fire("price", `${x.label} went up`, `${formatCents(inc.from)} → ${formatCents(inc.to)} (${formatCents((inc.to - inc.from) * 12)}/yr if monthly).`, `price:${x.key}:${x.lastDate}`);
  }

  // Low projected balance
  for (const f of cashForecast(householdId, today, 30, db)) {
    const b = f.result.firstBelowFloor;
    if (b) fire("low_balance", `${f.account.name} may run low`, `Projected ${formatCents(b.balance)} on ${b.date}${b.trigger ? ` after ${b.trigger.label}` : ""}.`, `low:${f.account.id}:${b.date}`);
  }

  // Debt: promo ending, utilization
  const accts = loadAccounts(householdId, db);
  for (const a of accts) {
    if (a.promoAprEnd && a.balance < 0) {
      const days = daysBetween(today, a.promoAprEnd);
      if (days >= 0 && days <= 60) fire("promo", `${a.name}: 0% APR ends in ${days} days`, `Balance ${formatCents(-a.balance)}.`, `promo:${a.id}:${a.promoAprEnd}`);
    }
  }
  const cards = accts.filter((a) => a.type === "credit_card" && !a.isHidden);
  const u = utilization(cards.map((a) => ({ id: a.id, owed: -a.balance, limit: a.creditLimit })));
  if (u.overall != null && u.overall > 0.3) fire("utilization", "Credit utilization above 30%", `Currently ${Math.round(u.overall * 100)}%. Paying before the statement closes lowers what's reported.`, `util:${month}`);

  // Duplicates waiting
  const dupes = db.select({ id: schema.transactions.id }).from(schema.transactions).where(and(eq(schema.transactions.householdId, householdId), isNotNull(schema.transactions.possibleDuplicateOf))).all().length;
  if (dupes) fire("duplicates", `${dupes} possible duplicate transactions`, "Review them so totals stay accurate.", `dupes:${today}`);

  // Month ready to close
  const prev = addMonths(month, -1);
  const closed = db.select().from(schema.monthCloses).where(and(eq(schema.monthCloses.householdId, householdId), eq(schema.monthCloses.month, prev))).get();
  if (!closed && Number(today.slice(8, 10)) >= 3) fire("close", `Time to close ${prev}`, "Schedule your monthly money date.", `close:${prev}`);

  return n;
}
