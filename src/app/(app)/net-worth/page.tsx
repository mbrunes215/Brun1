import { getContext } from "@/server/context";
import { netWorthAttribution, netWorthHistory } from "@/server/insights";
import { loadAccounts, toAccount, ownerLabel } from "@/server/repo";
import { netWorth } from "@/domain/networth";
import { Card, Money, PageHeader, Stat } from "@/components/ui";
import { LineChart, Legend, ShareBar, CHART_COLORS } from "@/components/charts";
import { addMonths, formatCents, monthEnd } from "@/domain/money";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<string, string> = { cash: "Cash", near_cash: "Savings", invested: "Taxable investments", retirement: "Retirement & HSA", illiquid: "Home & vehicles", liability: "Debts" };
const TAX_LABEL: Record<string, string> = { taxable: "Taxable", tax_deferred: "Tax-deferred", tax_free: "Roth (tax-free)", hsa: "HSA", education: "529" };

export default async function NetWorthPage() {
  const ctx = await getContext();
  const accts = loadAccounts(ctx.householdId).filter((a) => !a.isHidden).map(toAccount);
  const nw = netWorth(accts);
  const hist = netWorthHistory(ctx.householdId, 13).points;
  const m = ctx.today.slice(0, 7);
  const lastMonth = netWorthAttribution(ctx.householdId, monthEnd(addMonths(m, -2)), monthEnd(addMonths(m, -1)));
  const year = netWorthAttribution(ctx.householdId, monthEnd(addMonths(m, -13)), ctx.today);
  // Home equity: real estate minus linked mortgages.
  const rows = loadAccounts(ctx.householdId);
  const homes = rows.filter((a) => a.type === "real_estate");
  const equity = homes.map((h) => ({ name: h.name, value: h.balance, debt: rows.filter((r) => r.linkedAssetId === h.id).reduce((s, r) => s + r.balance, 0) }));
  const invested = nw.byTaxBucket.taxable + nw.byTaxBucket.tax_deferred + nw.byTaxBucket.tax_free + nw.byTaxBucket.hsa + nw.byTaxBucket.education;

  const AttributionRow = ({ label, cents, hint }: { label: string; cents: number; hint: string }) => (
    <div className="flex items-baseline justify-between border-b border-line py-1.5 last:border-0">
      <span>
        {label} <span className="text-xs text-muted">{hint}</span>
      </span>
      <Money cents={cents} sign colored />
    </div>
  );

  return (
    <>
      <PageHeader title="Net worth" subtitle="Everything you own minus everything you owe." />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Net worth" value={formatCents(nw.netWorth, { noCents: true })} />
        <Stat label="Assets" value={formatCents(nw.assets, { noCents: true })} />
        <Stat label="Debts" value={formatCents(-nw.liabilities, { noCents: true })} />
      </div>

      <Card className="mt-4" title="Trend">
        <Legend items={[{ name: "Net worth", color: "var(--chart-1)" }, { name: "Assets", color: "var(--chart-2)" }, { name: "Debts", color: "var(--chart-5)" }]} />
        <LineChart
          series={[
            { name: "Net worth", values: hist.map((p) => p.netWorth), color: "var(--chart-1)" },
            { name: "Assets", values: hist.map((p) => p.assets), color: "var(--chart-2)", dashed: true },
            { name: "Debts", values: hist.map((p) => -p.liabilities), color: "var(--chart-5)", dashed: true },
          ]}
          labels={hist.map((p) => new Date(p.month + "-15").toLocaleDateString("en-US", { month: "short", year: "2-digit" }))}
          height={200}
        />
        <p className="mt-2 text-xs text-muted">History builds from daily balance snapshots taken at each sync. Manual accounts update when you edit their balance.</p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {[
          ["Last month: what changed and why", lastMonth],
          ["Last 12 months", year],
        ].map(([title, a]) => {
          const att = a as typeof year;
          return (
            <Card key={title as string} title={title as string} subtitle="Separates what you did (saving, paying down debt) from what markets and valuations did.">
              <div className="text-sm">
                <AttributionRow label="Cash flow" cents={att.cashFlow} hint="change in cash & cards" />
                <AttributionRow label="Invested" cents={att.investmentContributions} hint="new contributions" />
                <AttributionRow label="Debt paid down" cents={att.debtPaydown} hint="loan principal" />
                <div className="flex justify-between py-1.5 font-semibold"><span>From your saving</span><Money cents={att.fromSaving} sign colored /></div>
                <AttributionRow label="Markets" cents={att.marketChange} hint="gains, losses, dividends" />
                <AttributionRow label="Asset values" cents={att.valuationChange} hint="home, vehicles" />
                <div className="flex justify-between pt-2 font-semibold"><span>Total change</span><Money cents={att.totalChange} sign colored /></div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="By liquidity" subtitle="How quickly you could reach the money.">
          <ShareBar parts={Object.entries(nw.byLiquidity).filter(([k]) => k !== "liability").map(([k, v], i) => ({ name: TIER_LABEL[k]!, value: v, color: CHART_COLORS[i % 6]! }))} />
          <ul className="mt-3 space-y-1 text-sm">
            {Object.entries(nw.byLiquidity).map(([k, v]) => (
              <li key={k} className="flex justify-between"><span>{TIER_LABEL[k]}</span><Money cents={v} /></li>
            ))}
          </ul>
        </Card>
        <Card title="Investments by tax treatment" subtitle="A mix of buckets gives flexibility to manage taxes in retirement.">
          <ShareBar parts={Object.entries(nw.byTaxBucket).filter(([k]) => k !== "none").map(([k, v], i) => ({ name: TAX_LABEL[k]!, value: v, color: CHART_COLORS[i % 6]! }))} />
          <ul className="mt-3 space-y-1 text-sm">
            {Object.entries(nw.byTaxBucket).filter(([k]) => k !== "none").map(([k, v]) => (
              <li key={k} className="flex justify-between"><span>{TAX_LABEL[k]}</span><span className="num"><Money cents={v} /> <span className="text-xs text-muted">{invested > 0 ? `${Math.round((v / invested) * 100)}%` : ""}</span></span></li>
            ))}
          </ul>
        </Card>
        <Card title="Yours, mine, ours">
          <ul className="space-y-1 text-sm">
            {(["A", "B", "joint"] as const).map((o) => (
              <li key={o} className="flex justify-between"><span>{ownerLabel(o, ctx.names)}</span><Money cents={nw.byOwner[o]} /></li>
            ))}
          </ul>
        </Card>
        {equity.length > 0 && (
          <Card title="Home equity">
            <ul className="space-y-2 text-sm">
              {equity.map((e) => (
                <li key={e.name}>
                  <div className="flex justify-between"><span>{e.name}</span><Money cents={e.value + e.debt} className="font-semibold" /></div>
                  <div className="text-xs text-muted">Value {formatCents(e.value, { noCents: true })} · Owed {formatCents(-e.debt, { noCents: true })} · {e.value > 0 ? `${Math.round(((e.value + e.debt) / e.value) * 100)}% equity` : ""}</div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
