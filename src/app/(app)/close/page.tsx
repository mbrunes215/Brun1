import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { coupleSummary, loadFunds, loadPlan, monthBudget } from "@/server/insights";
import { loadAccounts, loadTxnRows } from "@/server/repo";
import { closeMonth, reopenMonth, saveVarianceNote } from "@/server/actions";
import { Badge, Card, LinkButton, Money, Notice, PageHeader } from "@/components/ui";
import { addMonths, formatCents, monthEnd, monthStart } from "@/domain/money";

export const dynamic = "force-dynamic";

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-good text-white" : "bg-surface-2 text-muted"}`}>{done ? "✓" : n}</span>
      <div className="flex-1 pb-5">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-sm text-muted">{children}</div>
      </div>
    </li>
  );
}

export default async function ClosePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const db = getDb();
  const defaultMonth = Number(ctx.today.slice(8, 10)) <= 10 ? addMonths(ctx.today.slice(0, 7), -1) : ctx.today.slice(0, 7);
  const month = sp.month ?? defaultMonth;
  const closed = db.select().from(schema.monthCloses).where(and(eq(schema.monthCloses.householdId, ctx.householdId), eq(schema.monthCloses.month, month))).get();
  const allClosed = db.select().from(schema.monthCloses).where(eq(schema.monthCloses.householdId, ctx.householdId)).all().sort((a, b) => b.month.localeCompare(a.month));
  const rows = loadTxnRows(ctx.householdId, { start: monthStart(month), end: monthEnd(month) });
  const unreviewed = rows.filter((r) => !r.reviewedAt && !r.isHidden).length;
  const dupes = rows.filter((r) => r.possibleDuplicateOf).length;
  const suggestions = rows.filter((r) => r.transferSuggestedPairId && r.transferSuggestedPairId !== "rejected").length / 2;
  const uncategorized = rows.filter((r) => !r.categoryId && !r.isTransfer && !r.isHidden).length;
  const pending = rows.filter((r) => r.pending).length;
  const staleManual = loadAccounts(ctx.householdId).filter((a) => a.isManual && !a.isHidden && (!a.balanceDate || a.balanceDate < monthStart(month)));
  const couple = coupleSummary(ctx.householdId, ctx.today);
  const mb = monthBudget(ctx.householdId, month, ctx.today);
  const r = mb.result;
  const cats = new Map(mb.categories.map((c) => [c.id, c]));
  const { ledger } = loadFunds(ctx.householdId);
  const contributed = ledger.some((e) => e.kind === "contribution" && e.date >= monthStart(month) && e.date <= monthEnd(month));
  const nextPlan = loadPlan(ctx.householdId, addMonths(month, 1)).bm;
  const notes = new Map(mb.ledger ? loadPlan(ctx.householdId, month).lines.map((l) => [l.categoryId, l.varianceNote]) : []);
  const over = [...r.fixed.lines, ...r.flex.lines].filter((l) => l.budgeted > 0 && l.spent > l.budgeted + l.carryIn).sort((a, b) => b.spent - b.budgeted - (a.spent - a.budgeted));
  const cleanupDone = unreviewed === 0 && dupes === 0 && suggestions === 0 && uncategorized === 0;
  const isPast = monthEnd(month) < ctx.today;

  return (
    <>
      <PageHeader
        title="Monthly close"
        subtitle={`${new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" })}: a 20-minute money date, ideally together.`}
        actions={
          <>
            <LinkButton href={`/close?month=${addMonths(month, -1)}`}>← Prev</LinkButton>
            <LinkButton href={`/close?month=${addMonths(month, 1)}`}>Next →</LinkButton>
          </>
        }
      />
      {closed && <div className="mb-4"><Notice tone="good">Closed on {closed.closedAt.slice(0, 10)}. Transactions in this month are locked.</Notice></div>}
      {!isPast && !closed && <div className="mb-4"><Notice tone="info">This month isn't over yet. You can work through the steps now and close it after the last day.</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Checklist">
          <ol>
            <Step n={1} title="Review every transaction" done={unreviewed === 0 && uncategorized === 0}>
              {unreviewed} unreviewed, {uncategorized} uncategorized{pending ? `, ${pending} still pending` : ""}.{" "}
              {(unreviewed > 0 || uncategorized > 0) && <Link className="text-accent underline" href={`/transactions?month=${month}&filter=${unreviewed ? "unreviewed" : "uncategorized"}`}>Open queue</Link>}
            </Step>
            <Step n={2} title="Resolve duplicates and transfer suggestions" done={dupes === 0 && suggestions === 0}>
              {dupes} possible duplicates, {suggestions} transfer suggestions.{" "}
              {dupes > 0 && <Link className="text-accent underline" href="/transactions?filter=duplicates">Duplicates</Link>} {suggestions > 0 && <Link className="text-accent underline" href="/transactions?filter=transfers">Transfers</Link>}
            </Step>
            <Step n={3} title="Update manual balances" done={staleManual.length === 0}>
              {staleManual.length === 0 ? "Home, car, and manual loans are current." : <>Update: {staleManual.map((a, i) => <span key={a.id}>{i > 0 && ", "}<Link className="text-accent underline" href={`/accounts/${a.id}`}>{a.name}</Link></span>)}</>}
            </Step>
            <Step n={4} title="Settle up" done={couple.policy.fullyJoint || couple.all.balance === 0}>
              {couple.policy.fullyJoint ? "Fully joint." : couple.all.balance === 0 ? "All square." : <>{couple.all.balance > 0 ? couple.names.B : couple.names.A} owes {formatCents(Math.abs(couple.all.balance))}. <Link className="text-accent underline" href="/couple">Record it</Link></>}
            </Step>
            <Step n={5} title="Talk through the variances" done={over.every((l) => notes.get(l.categoryId))}>
              {over.length === 0 ? "Every category came in on or under plan." : (
                <ul className="mt-2 space-y-2">
                  {over.map((l) => (
                    <li key={l.categoryId} className="rounded-lg bg-surface-2 p-2">
                      <div className="flex justify-between text-fg"><span>{cats.get(l.categoryId)?.name}</span><span className="num text-bad">+{formatCents(l.spent - l.budgeted - l.carryIn, { noCents: true })}</span></div>
                      <form action={saveVarianceNote} className="mt-1 flex gap-2">
                        <input type="hidden" name="month" value={month} />
                        <input type="hidden" name="categoryId" value={l.categoryId} />
                        <input name="note" defaultValue={notes.get(l.categoryId) ?? ""} placeholder="Why? (one-off, new normal, adjust plan?)" className="!py-1 text-xs" />
                        <button className="rounded border border-line px-2 text-xs hover:bg-surface">Save</button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </Step>
            <Step n={6} title="Fund your sinking funds" done={contributed || mb.statuses.length === 0}>
              {mb.statuses.length === 0 ? "No funds set up." : contributed ? "Set-asides recorded for this month." : <>Suggested total {formatCents(mb.statuses.reduce((s, f) => s + f.setAside, 0))}. <Link className="text-accent underline" href={`/budget?month=${month}#funds`}>Record</Link></>}
            </Step>
            <Step n={7} title="Plan next month" done={!!nextPlan}>
              {nextPlan ? "Next month's plan exists." : <Link className="text-accent underline" href={`/budget?month=${addMonths(month, 1)}`}>Create next month's plan</Link>} Add any irregular expenses coming up.
            </Step>
          </ol>
          {closed ? (
            <form action={reopenMonth} className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
              <input type="hidden" name="month" value={month} />
              <div className="flex-1 space-y-1">
                <label htmlFor="reason">Reason for reopening (logged)</label>
                <input id="reason" name="reason" required />
              </div>
              <button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2">Reopen month</button>
            </form>
          ) : (
            <form action={closeMonth} className="border-t border-line pt-4">
              <input type="hidden" name="month" value={month} />
              <button className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!isPast}>
                Close {month}
              </button>
              {!cleanupDone && isPast && <span className="ml-3 text-xs text-warn">Some steps aren't done. You can still close.</span>}
            </form>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Month in numbers">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt>Income</dt><dd><Money cents={r.income.actual} /></dd></div>
              <div className="flex justify-between"><dt>Fixed</dt><dd><Money cents={r.fixed.spent} /> <span className="text-xs text-muted">/ {formatCents(r.fixed.budgeted, { noCents: true })}</span></dd></div>
              <div className="flex justify-between"><dt>Flex</dt><dd><Money cents={r.flex.spent} /> <span className="text-xs text-muted">/ {formatCents(r.flex.budgeted + r.flex.carryIn, { noCents: true })}</span></dd></div>
              <div className="flex justify-between"><dt>From sinking funds</dt><dd><Money cents={r.nonMonthly.spent} /></dd></div>
              <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>Left over</dt><dd><Money cents={r.income.actual - r.fixed.spent - r.flex.spent - r.nonMonthly.spent} colored /></dd></div>
            </dl>
          </Card>
          <Card title="Closed months">
            {allClosed.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
              <ul className="space-y-1 text-sm">
                {allClosed.slice(0, 12).map((c) => (
                  <li key={c.month} className="flex justify-between"><Link href={`/close?month=${c.month}`} className="hover:underline">{c.month}</Link><Badge tone="good">Closed</Badge></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
