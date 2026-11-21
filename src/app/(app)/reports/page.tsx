import Link from "next/link";
import { getContext } from "@/server/context";
import { loadLedger } from "@/server/repo";
import { healthScorecard } from "@/server/insights";
import { Card, LinkButton, Money, PageHeader, Stat, pct } from "@/components/ui";
import { Bars, Legend } from "@/components/charts";
import { summarize, spendingByMonth, ownerMatches } from "@/domain/ledger";
import { addMonths, formatCents, monthEnd, monthStart } from "@/domain/money";
import { taxPacket, TAX_TAGS } from "@/domain/tax";

export const dynamic = "force-dynamic";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const year = Number(sp.year ?? ctx.today.slice(0, 4));
  const m = ctx.today.slice(0, 7);
  const start = monthStart(addMonths(m, -11));
  const ledger = loadLedger(ctx.householdId, { start: `${year - 1}-01-01`, end: ctx.today });
  const lines = ledger.lines.filter((l) => ownerMatches(l, ctx.view));
  const cats = new Map(ledger.categories.map((c) => [c.id, c]));
  const months = [...spendingByMonth(lines.filter((l) => l.date >= start)).entries()];
  const ytd = summarize(lines, { start: `${year}-01-01`, end: `${year}-12-31` });
  const prior = summarize(lines, { start: `${year - 1}-01-01`, end: `${year - 1}-12-31` });
  const sc = healthScorecard(ctx.householdId, ctx.today);

  // Category totals for 12 months and the change vs. the prior 3 months.
  const t12 = summarize(lines, { start, end: ctx.today });
  const byGroup = new Map<string, number>();
  for (const [cid, amt] of t12.byCategory) {
    if (amt >= 0) continue;
    const g = cid ? cats.get(cid)?.group ?? "Other" : "Uncategorized";
    byGroup.set(g, (byGroup.get(g) ?? 0) - amt);
  }
  const groups = [...byGroup.entries()].sort((a, b) => b[1] - a[1]);
  const last3 = summarize(lines, { start: monthStart(addMonths(m, -3)), end: monthEnd(addMonths(m, -1)) });
  const prev3 = summarize(lines, { start: monthStart(addMonths(m, -6)), end: monthEnd(addMonths(m, -4)) });
  const movers = [...new Set([...last3.byCategory.keys(), ...prev3.byCategory.keys()])]
    .filter((cid): cid is string => !!cid && cats.get(cid)?.budgetType !== "income")
    .map((cid) => ({ cid, now: -(last3.byCategory.get(cid) ?? 0) / 3, before: -(prev3.byCategory.get(cid) ?? 0) / 3 }))
    .map((x) => ({ ...x, delta: x.now - x.before }))
    .filter((x) => Math.abs(x.delta) > 2500)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 8);
  const tax = taxPacket(ledger.lines, year);
  const total = groups.reduce((s, [, v]) => s + v, 0);

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`Viewing ${ctx.view === "household" ? "household" : ctx.view === "joint" ? "joint" : ctx.names[ctx.view]}`}
        actions={
          <>
            <LinkButton href={`/reports?year=${year - 1}`}>{year - 1}</LinkButton>
            <LinkButton href={`/api/export?format=csv&year=${year}`}>Export {year} CSV</LinkButton>
          </>
        }
      />
      <h2 className="mb-2 text-sm font-semibold text-muted">{year} year to date</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Income" value={formatCents(ytd.income, { noCents: true })} hint={prior.income ? `${year - 1}: ${formatCents(prior.income, { noCents: true })}` : undefined} />
        <Stat label="Spending" value={formatCents(ytd.spending, { noCents: true })} hint={prior.spending ? `${year - 1}: ${formatCents(prior.spending, { noCents: true })}` : undefined} />
        <Stat label="Moved to savings" value={formatCents(ytd.saved, { noCents: true })} />
        <Stat label="Cash savings rate" value={pct(ytd.income ? (ytd.income - ytd.spending) / ytd.income : null)} hint={sc.savingsRateIsTrue ? `True rate incl. payroll: ${sc.metrics.find((x) => x.key === "savings_rate")?.display}` : "Bank deposits only"} />
      </div>

      <Card className="mt-4" title="Cash flow, last 12 months">
        <Legend items={[{ name: "Income", color: "var(--chart-1)" }, { name: "Spending", color: "var(--chart-5)" }]} />
        <Bars
          data={months.map(([mm, s]) => ({
            label: new Date(mm + "-15").toLocaleDateString("en-US", { month: "short" }),
            values: [
              { name: "Income", value: s.income, color: "var(--chart-1)" },
              { name: "Spending", value: s.spending, color: "var(--chart-5)" },
            ],
          }))}
        />
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm num">
            <thead className="text-xs text-muted"><tr><th className="text-left">Month</th><th className="text-right">Income</th><th className="text-right">Spending</th><th className="text-right">Net</th><th className="text-right">Saved</th><th className="text-right">Rate</th></tr></thead>
            <tbody>
              {months.map(([mm, s]) => (
                <tr key={mm} className="border-t border-line">
                  <td>{mm}</td>
                  <td className="text-right"><Money cents={s.income} noCents /></td>
                  <td className="text-right"><Money cents={s.spending} noCents /></td>
                  <td className="text-right"><Money cents={s.net} noCents colored /></td>
                  <td className="text-right"><Money cents={s.saved} noCents /></td>
                  <td className="text-right">{pct(s.income ? s.net / s.income : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Where the money went (12 months)">
          <ul className="space-y-2 text-sm">
            {groups.map(([g, v]) => (
              <li key={g}>
                <div className="flex justify-between"><span>{g}</span><span className="num"><Money cents={v} noCents /> <span className="text-xs text-muted">{Math.round((v / total) * 100)}% · {formatCents(Math.round(v / 12), { noCents: true })}/mo</span></span></div>
                <div className="h-1.5 rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: `${(v / (groups[0]?.[1] ?? 1)) * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Biggest changes" subtitle="Monthly average, last 3 months vs the 3 before.">
          {movers.length === 0 ? <p className="text-sm text-muted">No big shifts.</p> : (
            <ul className="divide-y divide-line text-sm">
              {movers.map((x) => (
                <li key={x.cid} className="flex justify-between py-1.5">
                  <Link href={`/transactions?category=${x.cid}&filter=all`} className="hover:underline">{cats.get(x.cid)?.name}</Link>
                  <span className="num">{formatCents(x.before, { noCents: true })} → {formatCents(x.now, { noCents: true })} <span className={x.delta > 0 ? "text-bad" : "text-good"}>({x.delta > 0 ? "+" : ""}{formatCents(x.delta, { noCents: true })})</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4" title={`Tax packet ${year}`} subtitle="Totals of tagged transactions to hand to your tax preparer. Tag transactions with the keys below.">
        <div className="grid gap-2 sm:grid-cols-4">
          {TAX_TAGS.map((t) => (
            <div key={t.key} className="rounded-lg bg-surface-2 p-3">
              <div className="text-xs text-muted">{t.label}</div>
              <div className="font-semibold num">{formatCents(tax.totalsByTag[t.key] ?? 0)}</div>
              <div className="text-[11px] text-muted">#{t.key} · {tax.linesByTag[t.key]?.length ?? 0} items</div>
            </div>
          ))}
        </div>
        <div className="mt-3"><LinkButton href={`/api/export?format=tax&year=${year}`}>Download tax packet CSV</LinkButton></div>
      </Card>
    </>
  );
}
