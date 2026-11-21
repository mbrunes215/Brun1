import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { loadAccounts, loadTxnRows, toTxn } from "@/server/repo";
import { AccountForm } from "@/components/AccountForm";
import { Card, Money, Notice, PageHeader } from "@/components/ui";
import { LineChart } from "@/components/charts";
import { deleteAccount } from "@/server/actions";
import { reconcile } from "@/domain/reconcile";
import { addDays } from "@/domain/money";
import { amortizationSchedule } from "@/domain/debt";
import { INSTALLMENT_DEBT } from "@/domain/accounts";
import type { AccountType } from "@/domain/types";

export const dynamic = "force-dynamic";

export default async function AccountDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { id } = await params;
  const { saved } = await searchParams;
  const ctx = await getContext();
  const db = getDb();
  const a = db.select().from(schema.accounts).where(and(eq(schema.accounts.id, id), eq(schema.accounts.householdId, ctx.householdId))).get();
  if (!a) notFound();
  const snaps = db.select().from(schema.balanceSnapshots).where(eq(schema.balanceSnapshots.accountId, id)).orderBy(asc(schema.balanceSnapshots.date)).all();
  const txns = loadTxnRows(ctx.householdId, { accountId: id }).slice(0, 15);
  const assets = loadAccounts(ctx.householdId).filter((x) => x.type === "real_estate" || x.type === "vehicle");

  // Reconciliation: compare the bank's balance to the earliest snapshot + transactions since.
  let recon = null;
  if (!a.isManual && snaps.length >= 2 && a.reportedBalance != null) {
    const anchor = snaps[0]!;
    const all = loadTxnRows(ctx.householdId, { accountId: id, start: addDays(anchor.date, 1) }).map((r) => toTxn(r));
    recon = reconcile({ anchorBalance: anchor.balance, anchorDate: anchor.date, reportedBalance: a.reportedBalance, txns: all });
  }
  const isLoan = INSTALLMENT_DEBT.has(a.type as AccountType) && a.apr != null && a.minPayment;
  let payoff: { months: number; interest: number } | null = null;
  if (isLoan && a.balance < 0) {
    try {
      const rows = amortizationSchedule(-a.balance, a.apr!, a.minPayment!);
      payoff = { months: rows.length, interest: rows.reduce((s, r) => s + r.interest, 0) };
    } catch {
      payoff = null;
    }
  }

  return (
    <>
      <PageHeader title={a.name} subtitle={<><Money cents={a.balance} className="font-semibold text-fg" /> {a.balanceDate && `as of ${a.balanceDate}`}</>} actions={<Link href="/accounts" className="text-sm text-accent">← Accounts</Link>} />
      {saved && <div className="mb-4"><Notice tone="good">Saved.</Notice></div>}
      {recon && !recon.ok && (
        <div className="mb-4">
          <Notice tone="warn">
            Balance check: the bank reports <Money cents={recon.reported} /> but transactions add up to <Money cents={recon.computed} /> (off by <Money cents={recon.drift} />).
            {recon.suspects.length > 0 ? ` Likely culprit: ${recon.suspects.map((s) => `${s.payeeRaw} on ${s.date}`).join(", ")}.` : " Look for a missing or duplicated transaction, or a pending item."}
          </Notice>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Settings">
          <AccountForm account={a} names={ctx.names} assets={assets} />
        </Card>
        <div className="space-y-4">
          {snaps.length > 1 && (
            <Card title="Balance history">
              <LineChart points={snaps.map((s) => s.balance)} height={120} />
            </Card>
          )}
          {payoff && (
            <Card title="Payoff at minimum">
              <p className="text-sm">
                Paid off in <strong>{Math.floor(payoff.months / 12)}y {payoff.months % 12}m</strong> with <Money cents={payoff.interest} className="font-semibold" /> total interest remaining.{" "}
                <Link href="/debt" className="text-accent underline">Model extra payments</Link>
              </p>
            </Card>
          )}
          <Card title="Recent transactions" action={<Link className="text-xs text-accent" href={`/transactions?account=${a.id}&filter=all`}>All</Link>}>
            <ul className="divide-y divide-line text-sm">
              {txns.map((t) => (
                <li key={t.id} className="flex justify-between gap-2 py-1.5">
                  <Link href={`/transactions/${t.id}`} className="truncate hover:underline">{t.merchant ?? t.payeeRaw}</Link>
                  <Money cents={t.amount} />
                </li>
              ))}
              {txns.length === 0 && <li className="py-1.5 text-muted">None</li>}
            </ul>
          </Card>
          <Card title="Danger zone">
            <form action={deleteAccount}>
              <input type="hidden" name="id" value={a.id} />
              <button className="text-sm text-bad underline">Delete account and its transactions</button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
