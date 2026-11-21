import Link from "next/link";
import { getContext } from "@/server/context";
import { loadAccounts } from "@/server/repo";
import { Badge, Card, Empty, Money, Notice, PageHeader, Stat, pct } from "@/components/ui";
import { LineChart, Legend } from "@/components/charts";
import { compareStrategies, utilization, type Debt } from "@/domain/debt";
import { LIABILITY_TYPES } from "@/domain/accounts";
import { addMonths, daysBetween, formatCents } from "@/domain/money";
import type { AccountType } from "@/domain/types";

export const dynamic = "force-dynamic";

export default async function DebtPage({ searchParams }: { searchParams: Promise<{ extra?: string; mortgage?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const accounts = loadAccounts(ctx.householdId).filter((a) => LIABILITY_TYPES.has(a.type as AccountType) && !a.isHidden && a.balance < 0);
  const extra = Math.max(0, Math.round(Number(sp.extra ?? 200) * 100));
  const includeMortgage = sp.mortgage === "1";
  // Mortgages are usually left on schedule (extra payments compete with investing at similar rates), so they're opt-in.
  const inPlan = accounts.filter((a) => includeMortgage || a.type !== "mortgage");
  const usable = inPlan.filter((a) => a.apr != null && a.minPayment);
  // Cards without APR/minimum are assumed to be paid in full monthly; loans without them are missing data.
  const missing = inPlan.filter((a) => a.type !== "credit_card" && (a.apr == null || !a.minPayment));
  const debts: Debt[] = usable.map((a) => ({ id: a.id, name: a.name, balance: -a.balance, apr: a.apr!, minPayment: a.minPayment! }));
  let cmp: ReturnType<typeof compareStrategies> | null = null;
  let err: string | null = null;
  if (debts.length) {
    try {
      cmp = compareStrategies(debts, extra);
    } catch (e) {
      err = e instanceof Error ? e.message : "Could not simulate";
    }
  }
  const cards = accounts.filter((a) => a.type === "credit_card");
  const util = utilization(cards.map((a) => ({ id: a.id, owed: -a.balance, limit: a.creditLimit })));
  const promos = accounts.filter((a) => a.promoAprEnd && daysBetween(ctx.today, a.promoAprEnd) <= 90 && daysBetween(ctx.today, a.promoAprEnd) >= 0);
  const m = ctx.today.slice(0, 7);
  const label = (months: number) => new Date(addMonths(m, months) + "-15").toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const total = accounts.reduce((s, a) => s - a.balance, 0);

  return (
    <>
      <PageHeader title="Debt" subtitle="Payoff plans, interest costs, and credit utilization." />
      {accounts.length === 0 ? (
        <Empty title="No debts tracked">Nice. If you have loans SimpleFIN can't see, <Link className="text-accent underline" href="/accounts/new">add them manually</Link>.</Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Total owed" value={formatCents(total, { noCents: true })} />
            <Stat label="Monthly interest (est.)" value={formatCents(debts.reduce((s, d) => s + Math.round((d.balance * d.apr) / 12), 0), { noCents: true })} hint="At current balances and APRs" />
            <Stat label="Card utilization" value={pct(util.overall)} tone={util.overall == null ? undefined : util.overall < 0.1 ? "good" : util.overall < 0.3 ? "warn" : "bad"} hint="Under 30%, ideally under 10%" />
          </div>
          <div className="mt-3 space-y-2">
            {promos.map((a) => (
              <Notice key={a.id} tone="warn">{a.name}'s 0% promo ends {a.promoAprEnd}. Pay off <Money cents={-a.balance} /> before then or plan for the jump in interest.</Notice>
            ))}
            {missing.length > 0 && (
              <Notice tone="info">Add APR and minimum payment for {missing.map((a) => a.name).join(", ")} to include them in the payoff plan. <Link href={`/accounts/${missing[0]!.id}`} className="underline">Edit</Link></Notice>
            )}
            {cards.some((a) => !a.minPayment) && <Notice tone="info">Cards without a minimum payment set are treated as paid in full each month, which costs no interest. If you carry a balance on one, add its APR and minimum so it's prioritized (it's almost always the most expensive debt).</Notice>}
            {!includeMortgage && accounts.some((a) => a.type === "mortgage") && <p className="text-xs text-muted">Mortgage excluded from the plan: at typical rates, extra principal competes with investing and liquidity. Pay off consumer debt first, keep the emergency fund full, then decide.</p>}
          </div>

          <Card className="mt-4" title="Payoff planner" subtitle="Both strategies pay every minimum, then put the extra toward one debt at a time. Freed-up payments roll to the next debt.">
            <form className="mb-4 flex flex-wrap items-end gap-2" action="/debt">
              <div className="space-y-1">
                <label htmlFor="extra">Extra per month</label>
                <input id="extra" name="extra" inputMode="decimal" defaultValue={(extra / 100).toFixed(0)} className="!w-32" />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm text-fg">
                <input type="checkbox" name="mortgage" value="1" defaultChecked={includeMortgage} /> Include mortgage
              </label>
              <button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2">Recalculate</button>
            </form>
            {err && <Notice tone="bad">{err}</Notice>}
            {cmp && (
              <>
                <div className="grid gap-3 md:grid-cols-3">
                  {[
                    ["Avalanche", "Highest APR first. Least interest.", cmp.avalanche],
                    ["Snowball", "Smallest balance first. Quick wins.", cmp.snowball],
                    ["Minimums only", "Baseline", cmp.minimumsOnly],
                  ].map(([name, desc, r]) => {
                    const res = r as typeof cmp.avalanche;
                    return (
                      <div key={name as string} className="rounded-lg bg-surface-2 p-3 text-sm">
                        <div className="font-semibold">{name as string}</div>
                        <div className="text-xs text-muted">{desc as string}</div>
                        <div className="mt-2">Debt-free <strong>{label(res.months)}</strong> ({Math.floor(res.months / 12)}y {res.months % 12}m)</div>
                        <div>Interest <Money cents={res.totalInterest} className="font-semibold" /></div>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-3 text-sm">
                  Paying {formatCents(extra, { noCents: true })} extra saves <strong><Money cents={cmp.interestSavedVsMinimums} /></strong> in interest versus minimums.{" "}
                  {cmp.avalancheAdvantage > 0
                    ? <>Avalanche saves <Money cents={cmp.avalancheAdvantage} /> more than snowball. Snowball is still a fine choice if early wins keep you going.</>
                    : "Both strategies cost the same here."}
                </p>
                <div className="mt-3">
                  <Legend items={[{ name: "Avalanche", color: "var(--chart-1)" }, { name: "Snowball", color: "var(--chart-3)" }, { name: "Minimums", color: "var(--chart-5)" }]} />
                  <LineChart
                    series={[
                      { name: "Avalanche", values: [total, ...cmp.avalanche.timeline], color: "var(--chart-1)" },
                      { name: "Snowball", values: [total, ...cmp.snowball.timeline], color: "var(--chart-3)", dashed: true },
                      { name: "Minimums", values: [total, ...cmp.minimumsOnly.timeline], color: "var(--chart-5)", dashed: true },
                    ]}
                    height={180}
                  />
                </div>
                <h3 className="mb-1 mt-4 text-sm font-semibold">Avalanche order</h3>
                <ol className="space-y-1 text-sm">
                  {cmp.avalanche.order.map((id, i) => {
                    const d = debts.find((x) => x.id === id)!;
                    return (
                      <li key={id} className="flex justify-between">
                        <span>{i + 1}. {d.name} <span className="text-xs text-muted">{(d.apr * 100).toFixed(2)}% · min {formatCents(d.minPayment, { noCents: true })}</span></span>
                        <span className="num"><Money cents={d.balance} /> <Badge>{label(cmp!.avalanche.payoffMonthByDebt[id]!)}</Badge></span>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </Card>
        </>
      )}
    </>
  );
}
