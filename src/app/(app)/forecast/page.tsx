import Link from "next/link";
import { getContext } from "@/server/context";
import { cashForecast } from "@/server/insights";
import { Card, Empty, Money, Notice, PageHeader } from "@/components/ui";
import { LineChart } from "@/components/charts";
import { formatCents } from "@/domain/money";

export const dynamic = "force-dynamic";

export default async function ForecastPage() {
  const ctx = await getContext();
  const fc = cashForecast(ctx.householdId, ctx.today, 60);
  return (
    <>
      <PageHeader title="Cash forecast" subtitle="Next 60 days for each checking account: today's balance plus expected paychecks, minus bills and typical spending." />
      {fc.length === 0 && <Empty title="No checking accounts">Connect or add a checking account.</Empty>}
      <div className="space-y-4">
        {fc.map(({ account, result, daily, floor }) => (
          <Card key={account.id} title={account.name} subtitle={`Starts at ${formatCents(account.balance)} · assumes ${formatCents(daily, { noCents: true })}/day of everyday spending · alert floor ${formatCents(floor, { noCents: true })}`}>
            {result.firstBelowFloor ? (
              <Notice tone={result.firstBelowFloor.balance < 0 ? "bad" : "warn"}>
                Projected to drop to <Money cents={result.firstBelowFloor.balance} /> on {result.firstBelowFloor.date}
                {result.firstBelowFloor.trigger ? ` when ${result.firstBelowFloor.trigger.label} (${formatCents(-result.firstBelowFloor.trigger.amount)}) comes out` : ""}. Consider moving money in beforehand or shifting the bill's due date.
              </Notice>
            ) : (
              <Notice tone="good">Stays above your floor for the next 60 days. Lowest point: <Money cents={result.lowest.balance} /> on {result.lowest.date}.</Notice>
            )}
            <div className="mt-3">
              <LineChart
                series={[
                  { name: "Balance", values: result.days.map((d) => d.balance), color: "var(--chart-1)" },
                  { name: "Floor", values: result.days.map(() => floor), color: "var(--chart-5)", dashed: true },
                ]}
                labels={result.days.map((d) => d.date.slice(5).replace("-", "/"))}
                height={170}
              />
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-accent">Scheduled items</summary>
              <ul className="mt-2 divide-y divide-line text-sm">
                {result.days.flatMap((d) => d.events.map((e) => ({ ...e, bal: d.balance }))).map((e, i) => (
                  <li key={i} className="flex justify-between py-1">
                    <span><span className="text-muted num">{e.date.slice(5)}</span> {e.label}</span>
                    <span className="num"><Money cents={e.amount} colored /> <span className="text-xs text-muted">→ {formatCents(e.bal, { noCents: true })}</span></span>
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">Built from detected recurring transactions (<Link href="/recurring" className="underline">review them</Link>) and your 90-day average of other spending. Change the floor in Settings → Household.</p>
    </>
  );
}
