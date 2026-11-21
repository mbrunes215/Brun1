import { getContext } from "@/server/context";
import { recurringSeries, subscriptionsAnnual } from "@/server/insights";
import { loadAccounts, loadTxnRows, toTxn } from "@/server/repo";
import { setRecurringStatus } from "@/server/actions";
import { Badge, Card, Empty, Money, PageHeader, Stat } from "@/components/ui";
import { missedCharges, monthlyEquivalent, priceIncrease } from "@/domain/recurring";
import { addDays, formatCents } from "@/domain/money";

export const dynamic = "force-dynamic";

const CADENCE: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Monthly", quarterly: "Quarterly", semiannual: "Every 6 months", annual: "Yearly" };

export default async function RecurringPage() {
  const ctx = await getContext();
  const series = recurringSeries(ctx.householdId, ctx.today);
  const txns = loadTxnRows(ctx.householdId, { start: addDays(ctx.today, -400) }).map((r) => toTxn(r));
  const accts = new Map(loadAccounts(ctx.householdId).map((a) => [a.id, a.name]));
  const bills = series.filter((s) => s.direction === "outflow");
  const income = series.filter((s) => s.direction === "inflow");
  const missed = new Set(missedCharges(bills.filter((s) => s.status !== "cancelled"), ctx.today).map((s) => s.key));
  const annual = subscriptionsAnnual(bills);

  const Row = ({ s }: { s: (typeof series)[number] }) => {
    const inc = priceIncrease(s, txns);
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{s.label}</div>
          <div className="flex flex-wrap gap-1 text-[11px] text-muted">
            <span>{CADENCE[s.cadence]}</span>·<span>{accts.get(s.accountId)}</span>·<span>next {s.nextExpected}</span>
            {s.amountVaries && <Badge>Varies</Badge>}
            {s.status === "confirmed" && <Badge tone="good">Confirmed</Badge>}
            {s.status === "cancelled" && <Badge>Cancelled</Badge>}
            {inc && <Badge tone="warn">Price up {formatCents(inc.from)} → {formatCents(inc.to)}</Badge>}
            {missed.has(s.key) && <Badge tone="bad">Expected {s.nextExpected}, not seen</Badge>}
            {s.status === "cancelled" && s.lastDate > addDays(ctx.today, -40) && <Badge tone="bad">Cancelled but still charging?</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <Money cents={Math.abs(s.typicalAmount)} className="text-sm font-medium" />
            <div className="text-[11px] text-muted num">{formatCents(monthlyEquivalent(Math.abs(s.typicalAmount), s.cadence), { noCents: true })}/mo</div>
          </div>
          <form action={setRecurringStatus} className="flex gap-1">
            <input type="hidden" name="key" value={s.key} />
            <input type="hidden" name="label" value={s.label} />
            {s.status !== "confirmed" && <button name="status" value="confirmed" className="rounded border border-line px-2 py-0.5 text-[11px] hover:bg-surface-2">Confirm</button>}
            {s.direction === "outflow" && s.status !== "cancelled" && <button name="status" value="cancelled" className="rounded border border-line px-2 py-0.5 text-[11px] hover:bg-surface-2">I cancelled it</button>}
            <button name="status" value="dismissed" className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2">Not recurring</button>
          </form>
        </div>
      </li>
    );
  };

  return (
    <>
      <PageHeader title="Recurring" subtitle="Detected automatically from your history: bills, subscriptions, and paychecks." />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Recurring bills per year" value={formatCents(annual, { noCents: true })} hint={`${formatCents(Math.round(annual / 12), { noCents: true })} per month`} />
        <Stat label="Bills tracked" value={String(bills.length)} />
        <Stat label="Need attention" value={String(missed.size + bills.filter((s) => priceIncrease(s, txns)).length)} tone={missed.size ? "warn" : undefined} hint="Price increases and missed charges" />
      </div>
      <Card className="mt-4" title="Bills & subscriptions" subtitle="An annual subscription audit is one of the easiest raises you can give yourselves.">
        {bills.length === 0 ? <Empty title="Nothing detected yet">Needs about three months of history.</Empty> : <ul className="divide-y divide-line">{bills.map((s) => <Row key={s.key} s={s} />)}</ul>}
      </Card>
      <Card className="mt-4" title="Income">
        {income.length === 0 ? <p className="text-sm text-muted">No recurring income detected yet.</p> : <ul className="divide-y divide-line">{income.map((s) => <Row key={s.key} s={s} />)}</ul>}
      </Card>
    </>
  );
}
